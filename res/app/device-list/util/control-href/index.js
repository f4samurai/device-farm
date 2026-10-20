// 端末を開くリンク先。iOS は STF の操作画面（minicap 前提）では動かないので /ios で開く
module.exports = function controlHref(device) {
  return (device.platform === 'iOS' ? '#!/ios/' : '#!/control/') + device.serial
}
