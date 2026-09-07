/**
 * @deprecated 遗留文件，仅保留向后兼容导出。
 * 业务组件请统一接入 @/services/photoStorage 媒介门面；
 * 手机离线缓存实现请参考 @/services/mobilePhotoCache。
 */
export {
  saveMobileCachedPhoto as savePitPhoto,
  getMobileCachedPhoto as getPitPhoto,
  deleteMobileCachedPhoto as deletePitPhoto
} from './mobilePhotoCache'

