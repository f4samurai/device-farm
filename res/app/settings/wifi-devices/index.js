/**
* 無線 adb の端末を管理者が画面から追加・削除するタブ（サーバ側は lib/units/app/wifi-devices）
**/

require('./wifi-devices.css')

module.exports = angular.module('stf.settings.wifi-devices', [
  require('stf/common-ui').name
])
  .run(['$templateCache', function($templateCache) {
    $templateCache.put(
      'settings/wifi-devices/wifi-devices.pug', require('./wifi-devices.pug')
    )
  }])
  .controller('WifiDevicesCtrl', require('./wifi-devices-controller'))
