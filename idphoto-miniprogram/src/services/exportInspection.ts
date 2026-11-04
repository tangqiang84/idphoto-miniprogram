import Taro from '@tarojs/taro';
import { withTimeout, EXPORT_TIMEOUT_MS } from '../core/asyncUtils';
import { validateArtifact } from '../core/outputEvidence';

export async function inspectExportedFile(path: string, target: {width: number; height: number}, format: string) {
  const [size, info]: any[] = await withTimeout(Promise.all([
    Taro.getImageInfo({ src: path }),
    new Promise((resolve, reject) => Taro.getFileSystemManager().getFileInfo({ filePath: path, success: resolve, fail: reject })),
  ]), EXPORT_TIMEOUT_MS, 'export-inspection:timeout');
  const result = validateArtifact({ width: size.width, height: size.height, type: size.type, bytes: info.size }, target, format);
  if (!result.ok) throw result;
  return result;
}
