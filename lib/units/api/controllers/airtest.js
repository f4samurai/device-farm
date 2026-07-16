/**
* Runs run_test.py / deploygate_install_apk.py (from the sibling
* lead-native-game-autotest repo) against a device, triggered from the
* AirTest tab in the device control panel.
**/

var fs = require('fs')
var path = require('path')
var childProcess = require('child_process')

var logger = require('../../../util/logger')
var log = logger.createLogger('api:controllers:airtest')

// device-farm and lead-native-game-autotest are expected to be sibling
// directories under the same workspace (e.g. ~/lead-projects-scripts/).
var GAME_AUTOTEST_DIR = process.env.GAME_AUTOTEST_DIR ||
  path.resolve(__dirname, '../../../../../lead-native-game-autotest')
var SCRIPTS_DIR = path.join(GAME_AUTOTEST_DIR, 'scripts')
var RUN_TEST_SCRIPT = path.join(SCRIPTS_DIR, 'run_test.py')
var INSTALL_SCRIPT = path.join(GAME_AUTOTEST_DIR, 'python', 'deploygate_install_apk.py')

module.exports = {
  listAirtestScripts: listAirtestScripts
, runAirtestTest: runAirtestTest
, installAirtestApp: installAirtestApp
}

function listAirtestScripts(req, res) {
  fs.readdir(SCRIPTS_DIR, { withFileTypes: true }, function(err, entries) {
    if (err) {
      log.error('Failed to list AirTest scripts: %s', err.message)
      return res.status(500).json({
        success: false
      , description: 'Failed to list scripts: ' + err.message
      })
    }

    var scripts = entries
      .filter(function(entry) {
        return entry.isDirectory() && /\.air$/.test(entry.name)
      })
      .map(function(entry) {
        return entry.name.replace(/\.air$/, '')
      })
      .sort()

    res.json({
      success: true
    , scripts: scripts
    })
  })
}

// Fire-and-forget: used for AirTest runs, which can take several minutes
// and produce their own report rather than a single pass/fail message.
function spawnScript(serial, description, cwd, args) {
  log.info('Starting %s for "%s": python3 %s', description, serial, args.join(' '))

  var child = childProcess.spawn('python3', args, {
    cwd: cwd
  , detached: true
  , stdio: 'ignore'
  })
  child.unref()

  child.on('error', function(err) {
    log.error('Failed to start %s for "%s": %s', description, serial, err.message)
  })
}

// Waits for the script to finish and reports success/failure based on the
// exit code. Used for shorter-running actions (e.g. install) where the
// caller wants to know the actual result.
function runScriptAndWait(serial, description, cwd, args, callback) {
  log.info('Starting %s for "%s": python3 %s', description, serial, args.join(' '))

  var child = childProcess.spawn('python3', args, { cwd: cwd })
  var output = ''
  var done = false

  child.stdout.on('data', function(data) {
    output += data.toString()
  })
  child.stderr.on('data', function(data) {
    output += data.toString()
  })

  child.on('error', function(err) {
    if (done) {
      return
    }
    done = true
    log.error('Failed to start %s for "%s": %s', description, serial, err.message)
    callback(err, null)
  })

  child.on('close', function(code) {
    if (done) {
      return
    }
    done = true
    log.info('%s for "%s" exited with code %s', description, serial, code)
    callback(null, { code: code, output: output })
  })
}

function tailOutput(output, lines) {
  return output.trim().split('\n').slice(-lines).join('\n')
}

function runAirtestTest(req, res) {
  var serial = req.swagger.params.serial.value
  var appId = req.swagger.params.body.value.appId
  var script = req.swagger.params.body.value.script

  if (!appId) {
    return res.status(400).json({
      success: false
    , description: 'appId is required'
    })
  }

  var args = [
    RUN_TEST_SCRIPT
  , '--device', 'Android:///' + serial
  , '--app-id', appId
  ]
  if (script) {
    args.push('--script', script)
  }

  spawnScript(serial, 'AirTest', SCRIPTS_DIR, args)

  res.json({
    success: true
  , description: 'AirTest started for ' + serial + ' (' + appId + ')'
  })
}

function installAirtestApp(req, res) {
  var serial = req.swagger.params.serial.value
  var appId = req.swagger.params.body.value.appId

  if (!appId) {
    return res.status(400).json({
      success: false
    , description: 'appId is required'
    })
  }

  runScriptAndWait(serial, 'Install', path.join(GAME_AUTOTEST_DIR, 'python'), [
    INSTALL_SCRIPT
  , '--app-id', appId
  , '--serial', serial
  ], function(err, result) {
    if (err) {
      return res.status(500).json({
        success: false
      , description: 'Failed to start install: ' + err.message
      })
    }

    if (result.code === 0) {
      return res.json({
        success: true
      , description: 'Installed ' + appId + ' on ' + serial
      })
    }

    res.status(500).json({
      success: false
    , description: 'Install failed (exit ' + result.code + '): ' + tailOutput(result.output, 5)
    })
  })
}
