#!/usr/bin/env node
'use strict';

/**
 * Standalone, Node-22-native replacement for the parts of `grunt build`/`grunt minall` that
 * actually produce the shipped library (concat + version-stamp + minify). It reads the same
 * source of truth as the Grunt build (angularFiles.js, src/*.prefix|*.suffix) so the output is
 * structurally identical to what the official toolchain would produce.
 *
 * Deliberately skips everything in Gruntfile.js/lib/grunt that doesn't affect the shipped
 * library: docs generation (dgeni), Protractor/Selenium e2e, SauceLabs/Firebase deploy, the
 * mandatory `yarn install` Gruntfile.js runs on load, and the network-dependent CDN version
 * lookup in lib/versions/version-info.js. None of that changes what a consuming app receives.
 *
 * Usage: node scripts/build-lib.js [--no-minify]
 */

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var BUILD_DIR = path.join(ROOT, 'build');
var angularFiles = require(path.join(ROOT, 'angularFiles')).files;

var MINIFY = process.argv.indexOf('--no-minify') === -1;

function abs(relPath) {
  return path.join(ROOT, relPath);
}

function read(relPath) {
  return fs.readFileSync(abs(relPath), 'utf8');
}

// ---------------------------------------------------------------------------
// Version string (cosmetic only -- embedded in angular.version and error-message URLs,
// not consulted by any runtime behavior, so a simplified local computation is safe).
// ---------------------------------------------------------------------------

function git(args) {
  var result = childProcess.spawnSync('git', args, {cwd: ROOT, encoding: 'utf8'});
  return result.status === 0 ? result.stdout.trim() : null;
}

function getVersion() {
  var describe = git(['describe', '--tags']);
  var shortSha = git(['rev-parse', '--short', 'HEAD']) || 'unknown';

  var tag = describe ? describe.match(/^v?(\d+)\.(\d+)\.(\d+)/) : null;
  var major = tag ? Number(tag[1]) : 0;
  var minor = tag ? Number(tag[2]) : 0;
  var patch = tag ? Number(tag[3]) : 0;
  var exactTag = describe ? !/-\d+-g[0-9a-f]+$/.test(describe) : false;

  var full = major + '.' + minor + '.' + patch + (exactTag ? '' : '-local.' + shortSha);

  return {
    full: full,
    major: major,
    minor: minor,
    patch: patch,
    cdn: full,
    codeName: exactTag ? 'release' : 'snapshot'
  };
}

// ---------------------------------------------------------------------------
// build(): concat + wrap + version-substitute + strict-dedupe
// (mirrors lib/grunt/utils.js's build()/process()/singleStrict()/addStyle())
// ---------------------------------------------------------------------------

function wrap(files, name) {
  return [path.join('src', name + '.prefix')].concat(files, [path.join('src', name + '.suffix')]);
}

function substituteVersion(src, version) {
  return src
    .replace(/(['"])NG_VERSION_FULL\1/g, version.full)
    .replace(/(['"])NG_VERSION_MAJOR\1/, version.major)
    .replace(/(['"])NG_VERSION_MINOR\1/, version.minor)
    .replace(/(['"])NG_VERSION_DOT\1/, version.patch)
    .replace(/(['"])NG_VERSION_CDN\1/, version.cdn)
    .replace(/(['"])NG_VERSION_CODENAME\1/, version.codeName);
}

function singleStrict(src, insert) {
  return src
    .replace(/\s*("|')use strict("|');\s*/g, insert)
    .replace(/(\(function\([^)]*\)\s*\{)/, '$1\'use strict\';');
}

function processSource(src, version, strict) {
  var processed = substituteVersion(src, version);
  if (strict !== false) processed = singleStrict(processed, '\n\n');
  return processed;
}

function escapeCssForJs(css) {
  return css
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\\\'')
    .replace(/\r?\n/g, '\\n');
}

function minifyCss(css) {
  return css
    .replace(/\r?\n/g, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/:\s+/g, ':')
    .replace(/\s*\{\s*/g, '{')
    .replace(/\s*\}\s*/g, '}')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s*;\s*/g, ';');
}

function addStyle(src, cssFiles, generateCspCssFile) {
  var jsParts = [src];
  var cssParts = [];

  cssFiles.forEach(function(cssFile) {
    var css = read(cssFile);
    cssParts.push(css);
    var jsInjection = '!window.angular.$$csp().noInlineStyle && ' +
      'window.angular.element(document.head).prepend(' +
      'window.angular.element(\'<style>\').text(\'' + escapeCssForJs(minifyCss(css)) + '\'));';
    jsParts.push(jsInjection);
  });

  if (generateCspCssFile) {
    var cspHeader = '/* Include this file in your html if you are using the CSP mode. */\n\n';
    fs.writeFileSync(path.join(BUILD_DIR, 'angular-csp.css'), cspHeader + cssParts.join('\n'));
  }

  return jsParts.join('\n');
}

function buildTarget(target, version) {
  var src = target.files.map(read).join('\n');
  var processed = processSource(src, version, target.strict);
  if (target.styles) {
    processed = addStyle(processed, target.styles, true);
  }
  var destPath = path.join(BUILD_DIR, target.dest);
  fs.writeFileSync(destPath, processed);
  console.log('File build/' + target.dest + ' created.');
  return destPath;
}

// ---------------------------------------------------------------------------
// min(): shell out to the vendored Java Closure Compiler (unchanged from the original
// build -- not Node-version-sensitive at all, java + jars confirmed present).
// ---------------------------------------------------------------------------

function minifyTarget(filePath, version) {
  var minFile = filePath.replace(/\.js$/, '.min.js');
  var mapFile = minFile + '.map';
  var mapFileName = path.basename(mapFile);
  var errorFile = filePath.replace(/\.js$/, '-errors.json');
  var isMessageFormat = path.basename(filePath) === 'angular-message-format.js';
  var compilationLevel = isMessageFormat ? 'ADVANCED_OPTIMIZATIONS' : 'SIMPLE_OPTIMIZATIONS';
  var classpathSep = process.platform === 'win32' ? ';' : ':';

  var args = [
    '-Xmx2g',
    '-cp', abs('vendor/closure-compiler/compiler.jar') + classpathSep + abs('vendor/ng-closure-runner/ngcompiler.jar'),
    'org.angularjs.closurerunner.NgClosureRunner',
    '--compilation_level', compilationLevel,
    '--language_in', 'ECMASCRIPT5_STRICT',
    '--minerr_pass',
    '--minerr_errors', errorFile,
    '--minerr_url', 'https://errors.angularjs.org/' + version.full + '/',
    '--source_map_format=V3',
    '--create_source_map', mapFile,
    '--js', filePath,
    '--js_output_file', minFile
  ];

  var result = childProcess.spawnSync('java', args, {cwd: ROOT, encoding: 'utf8'});
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error('Error minifying ' + filePath);
  }

  // Closure creates the source map relative to build/, strip those references (matches original).
  var mapContent = fs.readFileSync(mapFile, 'utf8')
    .replace('"file":"build/', '"file":"')
    .replace('"sources":["build/', '"sources":["');
  fs.writeFileSync(mapFile, mapContent);

  var minContent = fs.readFileSync(minFile, 'utf8');
  minContent = singleStrict(minContent, '\n') + '//# sourceMappingURL=' + mapFileName + '\n';
  fs.writeFileSync(minFile, minContent);

  console.log(path.relative(ROOT, filePath) + ' minified into ' + path.relative(ROOT, minFile));
}

// ---------------------------------------------------------------------------
// Target definitions (mirrors Gruntfile.js's `build`/`min` config, lines 197-324)
// ---------------------------------------------------------------------------

function defineTargets() {
  var m = angularFiles.angularModules;
  var moduleTarget = function(name, key) {
    return {dest: 'angular-' + name + '.js', files: wrap(m[key], 'module'), minify: true};
  };

  return [
    {
      dest: 'angular.js',
      files: wrap(angularFiles.angularSrc, 'angular'),
      styles: ['css/angular.css'],
      minify: true
    },
    {dest: 'angular-loader.js', files: wrap(angularFiles.angularLoader, 'loader'), minify: true},
    {dest: 'angular-mocks.js', files: wrap(m.ngMock, 'module'), strict: false, minify: false},
    moduleTarget('touch', 'ngTouch'),
    moduleTarget('sanitize', 'ngSanitize'),
    moduleTarget('resource', 'ngResource'),
    moduleTarget('message-format', 'ngMessageFormat'),
    moduleTarget('messages', 'ngMessages'),
    moduleTarget('animate', 'ngAnimate'),
    moduleTarget('route', 'ngRoute'),
    moduleTarget('cookies', 'ngCookies'),
    moduleTarget('aria', 'ngAria'),
    {dest: 'angular-parse-ext.js', files: wrap(m.ngParseExt, 'module'), minify: false}
  ];
}

function main() {
  var version = getVersion();
  console.log('Building AngularJS ' + version.full + ' (Node ' + process.version + ')');

  fs.rmSync(BUILD_DIR, {recursive: true, force: true});
  fs.mkdirSync(BUILD_DIR, {recursive: true});

  var targets = defineTargets();
  var builtPaths = targets.map(function(target) { return buildTarget(target, version); });

  if (MINIFY) {
    targets.forEach(function(target, i) {
      if (target.minify) minifyTarget(builtPaths[i], version);
    });
  } else {
    console.log('Skipping minification (--no-minify)');
  }

  // Also expose the two files consumers expect to find at the package root
  // (e.g. `node_modules/angular/angular.min.js`), alongside package.json.
  ['angular.min.js', 'angular-csp.css'].forEach(function(file) {
    var src = path.join(BUILD_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, abs(file));
      console.log('Copied build/' + file + ' to ' + file + '.');
    }
  });

  console.log('Done.');
}

main();
