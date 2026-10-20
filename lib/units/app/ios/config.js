/**
* iOS 端末の接続先設定を読み込む。
*
* STF 本体のデバイス管理（adb / provider）とは独立していて、
* ここに書いた WDA と MJPEG の URL をそのまま使う。
**/

var fs = require('fs')
var os = require('os')
var url = require('url')

var logger = require('../../../util/logger')
var pathutil = require('../../../util/pathutil')

var log = logger.createLogger('app:ios:config')

// 既定の置き場所。環境変数 STF_IOS_DEVICES で上書きできる。
var DEFAULT_PATH = pathutil.root('ios-devices.json')

module.exports.path = function() {
  return process.env.STF_IOS_DEVICES || DEFAULT_PATH
}

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
    // STF の serial になる。無い端末は STF の一覧に載らず、占有も操作もできない（見るだけ）
  , udid: entry.udid || null
    // 一覧の機種欄（任意）。既定は iPhone
  , model: entry.model || null
  , wdaUrl: entry.wdaUrl.replace(/\/+$/, '')
  , mjpegUrl: entry.mjpegUrl.replace(/\/+$/, '')
    // true にすると WDA の MJPEG 出力を端末の向きに合わせて回転させる。
    // 共有中の WDA セッションの設定を書き換えるので既定は false。
  , fixOrientation: entry.fixOrientation === true
    // WDA の MJPEG は既定 10fps と控えめなので上げられるようにする。
    // 未指定なら何も送らない（他の利用者と共有する設定のため）。
  , framerate: entry.framerate || null
  , quality: entry.quality || null
    // WDA を起動したスクリプトが書く URL ファイル（例: ~/wda_logs/wda_url_<UDID>.txt）。
    // 端末の IP は DHCP で変わるため、あればそのホストを wdaUrl / mjpegUrl に使う（ポートは上の設定のまま）
  , wdaUrlFile: entry.wdaUrlFile ?
      entry.wdaUrlFile.replace(/^~(?=\/)/, os.homedir()) :
      null
  }
}

var hostCache = Object.create(null)

// URL ファイルからホストを読む。読めなければ null（設定の URL をそのまま使う）
function readHost(file) {
  var stat
  try {
    // eslint-disable-next-line no-sync
    stat = fs.statSync(file)
  }
  catch (err) {
    return null
  }

  var cached = hostCache[file]
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.host
  }

  var host = null
  try {
    // eslint-disable-next-line no-sync
    host = url.parse(fs.readFileSync(file, 'utf8').trim()).hostname || null
  }
  catch (err) {
    log.warn('Unable to read WDA URL file "%s": %s', file, err.message)
  }
  hostCache[file] = {mtimeMs: stat.mtimeMs, host: host}
  return host
}

function withHost(target, host) {
  var parsed = url.parse(target)
  parsed.hostname = host
  parsed.host = null
  return url.format(parsed).replace(/\/+$/, '')
}

// いま繋ぐべき wdaUrl / mjpegUrl を入れた端末設定を返す
module.exports.resolve = function(device) {
  var host = device.wdaUrlFile && readHost(device.wdaUrlFile)
  if (!host) {
    return device
  }
  return Object.assign({}, device, {
    wdaUrl: withHost(device.wdaUrl, host)
  , mjpegUrl: withHost(device.mjpegUrl, host)
  })
}

module.exports.load = function() {
  var file = module.exports.path()

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
