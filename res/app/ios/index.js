require('./ios.css')

module.exports = angular.module('stf.ios', [])
  .config(['$routeProvider', function($routeProvider) {
    $routeProvider
      .when('/ios', {
        template: require('./ios.pug'),
        controller: 'IosCtrl'
      })
  }])
  .controller('IosCtrl', require('./ios-controller'))
