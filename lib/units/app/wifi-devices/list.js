/**
* 無線 adb の端末一覧（wifi-devices.txt）を読み書きする。
*
* 1 行 1 台で `IP:ポート`。`#` から行末まではコメント。
* 起動スクリプト（lead-projects-scripts の python/launchd/agent005/device-farm-start.sh）も
* 同じファイルを 60 秒ごとに読んで `adb connect` し直すので、書式を変えるときは両方そろえる。
**/

var fs = require('fs')

var pathutil = require('../../../util/pathutil')

// 既定の置き場所。環境変数 STF_WIFI_DEVICES で上書きできる（ios-devices.json と同じ考え方）
var DEFAULT_PATH = pathutil.root('wifi-devices.txt')
var DEFAULT_PORT = 5555

module.exports.path = function() {
  return process.env.STF_WIFI_DEVICES || DEFAULT_PATH
}

// 社内 LAN の IPv4 だけを受け付ける。adb server は繋がったものを何でも STF の端末にするので、
// 社外のホストや localhost を登録させない
function isPrivate(octets) {
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
}

// "192.168.1.146" / "192.168.1.146:5555" → "192.168.1.146:5555"。受け付けないものは null
module.exports.normalize = function(input) {
  var match = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?\s*$/
    .exec(String(input || ''))
  if (!match) {
    return null
  }
  var octets = match.slice(1, 5).map(Number)
  var tooLarge = octets.some(function(n) {
    return n > 255
  })
  if (tooLarge || !isPrivate(octets)) {
    return null
  }
  var port = match[5] ? Number(match[5]) : DEFAULT_PORT
  if (port < 1 || port > 65535) {
    return null
  }
  return octets.join('.') + ':' + port
}

function readLines() {
  try {
    // eslint-disable-next-line no-sync
    return fs.readFileSync(module.exports.path(), 'utf8').split(/\r?\n/)
  }
  catch (err) {
    if (err.code === 'ENOENT') {
      return []
    }
    throw err
  }
}

function addressOf(line) {
  return line.replace(/#.*/, '').trim()
}

// 途中で落ちても壊れたファイルを残さないよう、隣に書いてから差し替える
function writeLines(lines) {
  var file = module.exports.path()
  var tmp = file + '.tmp'
  // eslint-disable-next-line no-sync
  fs.writeFileSync(tmp, lines.join('\n').replace(/\n*$/, '\n'))
  // eslint-disable-next-line no-sync
  fs.renameSync(tmp, file)
}

module.exports.load = function() {
  return readLines().map(addressOf).filter(Boolean)
}

// 足したら true、既にあれば false
module.exports.add = function(address) {
  var lines = readLines()
  if (lines.map(addressOf).indexOf(address) !== -1) {
    return false
  }
  while (lines.length && lines[lines.length - 1].trim() === '') {
    lines.pop()
  }
  lines.push(address)
  writeLines(lines)
  return true
}

// 消したら true。コメント行や他の端末の行はそのまま残す
module.exports.remove = function(address) {
  var lines = readLines()
  var kept = lines.filter(function(line) {
    return addressOf(line) !== address
  })
  if (kept.length === lines.length) {
    return false
  }
  writeLines(kept)
  return true
}
