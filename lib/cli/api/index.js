/**
* Copyright © 2019 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
**/

module.exports.command = 'api'

module.exports.describe = 'Start an API unit.'

module.exports.builder = function(yargs) {
  return yargs
    .env('STF_API')
    .strict()
    .option('adb-host', {
      describe: 'The ADB server host (used to connect Wi-Fi devices).'
    , type: 'string'
    , default: '127.0.0.1'
    })
    .option('adb-port', {
      describe: 'The ADB server port (used to connect Wi-Fi devices).'
    , type: 'number'
    , default: 5037
    })
    .option('connect-push', {
      alias: 'c'
    , describe: 'App-side ZeroMQ PULL endpoint to connect to.'
    , array: true
    , demand: true
    })
    .option('connect-sub', {
      alias: 'u'
    , describe: 'App-side ZeroMQ PUB endpoint to connect to.'
    , array: true
    , demand: true
    })
    .option('connect-push-dev', {
      alias: 'pd'
    , describe: 'Device-side ZeroMQ PULL endpoint to connect to.'
    , array: true
    , demand: true
    })
    .option('connect-sub-dev', {
      alias: 'sd'
    , describe: 'Device-side ZeroMQ PUB endpoint to connect to.'
    , array: true
    , demand: true
    })
    .option('port', {
      alias: 'p'
    , describe: 'The port to bind to.'
    , type: 'number'
    , default: process.env.PORT || 7106
    })
    .option('secret', {
      alias: 's'
    , describe: 'The secret to use for auth JSON Web Tokens. Anyone who ' +
        'knows this token can freely enter the system if they want, so keep ' +
        'it safe.'
    , type: 'string'
    , default: process.env.SECRET
    , demand: true
    })
    .option('ssid', {
      alias: 'i'
    , describe: 'The name of the session ID cookie.'
    , type: 'string'
    , default: process.env.SSID || 'ssid'
    })
    .epilog('Each option can be be overwritten with an environment variable ' +
      'by converting the option to uppercase, replacing dashes with ' +
      'underscores and prefixing it with `STF_API_` (e.g. ' +
      '`STF_API_PORT`).')
}

module.exports.handler = function(argv) {
  return require('../../units/api')({
    port: argv.port
  , ssid: argv.ssid
  , secret: argv.secret
  , adbHost: argv.adbHost
  , adbPort: argv.adbPort
  , endpoints: {
      push: argv.connectPush
    , sub: argv.connectSub
    , pushdev: argv.connectPushDev
    , subdev: argv.connectSubDev
    }
  })
}
