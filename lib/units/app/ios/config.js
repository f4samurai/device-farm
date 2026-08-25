/**
* iOS 端末の接続先設定を読み込む。
*
* STF 本体のデバイス管理（adb / provider）とは独立していて、
* ここに書いた WDA と MJPEG の URL をそのまま使う。
**/

var fs = require('fs')

var logger = require('../../../util/logger')
var pathutil = require('../../../util/pathutil')

var log = logger.createLogger('app:ios:config')

// 既定の置き場所。環境変数 STF_IOS_DEVICES で上書きできる。
var DEFAULT_PATH = pathutil.root('ios-devices.json')

function normalize(entry, index) {
  if (!entry.wdaUrl) {
    throw new Error('ios-devices.json[' + index + ']: wdaUrl は必須')
  }
  if (!entry.mjpegUrl) {
    throw new Error('ios-devices.json[' + index + ']: mjpegUrl は必須')
  }

  return {
    id: entry.id || ('ios' + index)
  , name: entry.name || entry.id || ('iOS device ' + index)
  , udid: entry.udid || null
  , wdaUrl: entry.wdaUrl.replace(/\/+$/, '')
  , mjpegUrl: entry.mjpegUrl.replace(/\/+$/, '')
    // true にすると WDA の MJPEG 出力を端末の向きに合わせて回転させる。
    // 共有中の WDA セッションの設定を書き換えるので既定は false。
  , fixOrientation: entry.fixOrientation === true
  }
}

module.exports.load = function() {
  var file = process.env.STF_IOS_DEVICES || DEFAULT_PATH

  var raw
  try {
    // eslint-disable-next-line no-sync
    raw = fs.readFileSync(file, 'utf8')
  }
  catch (err) {
    if (err.code === 'ENOENT') {
      log.info('No iOS device config at "%s", iOS pane will be empty', file)
      return []
    }
    throw err
  }

  var parsed = JSON.parse(raw)
  var devices = (parsed.devices || []).map(normalize)

  log.info('Loaded %d iOS device(s) from "%s"', devices.length, file)
  return devices
}
