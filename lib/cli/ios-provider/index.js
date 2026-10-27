module.exports.command = 'ios-provider [name]'

module.exports.describe =
  'Start an iOS provider unit (lists iOS devices in STF and handles ownership).'

module.exports.builder = function(yargs) {
  return yargs
    .env('STF_IOS_PROVIDER')
    .strict()
    .option('connect-push', {
      alias: 'p'
    , describe: 'Device-side ZeroMQ PULL endpoint to connect to.'
    , array: true
    , demand: true
    })
    .option('connect-sub', {
      alias: 's'
    , describe: 'Device-side ZeroMQ PUB endpoint to connect to.'
    , array: true
    , demand: true
    })
    .option('group-timeout', {
      alias: 't'
    , describe: 'Timeout in seconds for automatic release of inactive devices.'
    , type: 'number'
    , default: 900
    })
    .option('name', {
      describe: 'Provider name shown in the device list.'
    , type: 'string'
    , default: 'ios-provider'
    })
    .epilog('Devices are read from ios-devices.json (or $STF_IOS_DEVICES). ' +
      'Each option can be be overwritten with an environment variable ' +
      'by converting the option to uppercase, replacing dashes with ' +
      'underscores and prefixing it with `STF_IOS_PROVIDER_` (e.g. ' +
      '`STF_IOS_PROVIDER_CONNECT_PUSH`).')
}

module.exports.handler = function(argv) {
  return require('../../units/ios-provider')({
    name: argv.name
  , groupTimeout: argv.groupTimeout
  , endpoints: {
      push: argv.connectPush
    , sub: argv.connectSub
    }
  })
}
