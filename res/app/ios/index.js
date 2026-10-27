require('./ios.css')

module.exports = angular.module('stf.ios', [
  require('stf/device').name
  , require('stf/user/group').name
])
  .config(['$routeProvider', function($routeProvider) {
    $routeProvider
      .when('/ios', {
        template: require('./ios.pug')
        , controller: 'IosCtrl'
      })
      // 端末一覧から UDID（STF の serial）で来る。?view なら占有せずに見るだけ
      .when('/ios/:serial', {
        template: require('./ios.pug')
        , controller: 'IosCtrl'
        // 占有・解放で ?view を付け外ししても画面（ストリーム）を作り直さない
        , reloadOnSearch: false
      })
  }])
  .controller('IosCtrl', require('./ios-controller'))
