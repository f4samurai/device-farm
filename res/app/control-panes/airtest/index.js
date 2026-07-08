module.exports = angular.module('stf.airtest', [])
  .run(['$templateCache', function($templateCache) {
    $templateCache.put('control-panes/airtest/airtest.pug',
      require('./airtest.pug')
    )
  }])
  .controller('AirtestCtrl', require('./airtest-controller'))
