// 背景图片工具：把本地图片压缩成可控体积的 data URL，避免撑爆 localStorage。
// 用 canvas 缩放到最大边 1600px、JPEG 质量 0.82；PNG 透明图保留 PNG。

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

/** 从本地路径读取并压缩图片，返回 { dataUrl, width, height }。 */
export async function loadAndCompressImage(path, ipc) {
  const b64 = await ipc.fetchImageAsBase64(path);
  const ext = (path || '').split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const srcDataUrl = `data:${mime};base64,${b64}`;

  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('图片解码失败，请换一张图片'));
    im.src = srcDataUrl;
  });

  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('图片尺寸无效');

  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  // 透明图保留透明通道；不透明图统一 JPEG 以减小体积
  const hasAlpha = ext === 'png' || ext === 'webp' || ext === 'gif';
  if (!hasAlpha) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tw, th);
  }
  ctx.drawImage(img, 0, 0, tw, th);

  const outMime = hasAlpha ? 'image/png' : 'image/jpeg';
  const dataUrl = canvas.toDataURL(outMime, hasAlpha ? undefined : JPEG_QUALITY);
  return { dataUrl, width: tw, height: th, bytes: Math.round((dataUrl.length * 3) / 4) };
}
