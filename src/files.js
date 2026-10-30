// Salvar/compartilhar e ler arquivos, no navegador e dentro do APK (Capacitor).
// No WebView do Android não há download por <a download> nem Web Share, então o APK
// grava o arquivo no cache com o plugin Filesystem e abre a folha de compartilhamento.

const native = () => window.Capacitor?.isNativePlatform?.() === true;

export async function saveFile(name, text, type = 'application/json') {
  if (native()) {
    const { Filesystem, Share } = window.Capacitor.Plugins;
    const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
    await Share.share({ title: name, files: [uri], dialogTitle: 'Enviar arquivo' });
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readJsonFile(file) {
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('O arquivo não é um JSON válido.');
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Não foi possível ler ${file.name}.`));
    };
    img.src = url;
  });
}

// Caixa do conteúdo: ignora bordas transparentes ou quase brancas (foto de catálogo).
function contentBox(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  const isBackground = (i) => data[i + 3] < 16 || (data[i] > 244 && data[i + 1] > 244 && data[i + 2] > 244);
  let top = h;
  let left = w;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isBackground((y * w + x) * 4)) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (right < 0) return { x: 0, y: 0, w, h }; // imagem toda branca: não corta
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

// Imagem de produto para o planograma: sem bordas, no máximo `maxSide` px, WebP (com transparência).
export async function processProductImage(file, maxSide = 480) {
  const img = await loadImage(file);
  // analisa numa cópia pequena para não varrer milhões de pixels
  const probeScale = Math.min(1, 400 / Math.max(img.width, img.height));
  const probe = document.createElement('canvas');
  probe.width = Math.max(1, Math.round(img.width * probeScale));
  probe.height = Math.max(1, Math.round(img.height * probeScale));
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(img, 0, 0, probe.width, probe.height);
  const box = contentBox(pctx, probe.width, probe.height);
  const sx = box.x / probeScale;
  const sy = box.y / probeScale;
  const sw = box.w / probeScale;
  const sh = box.h / probeScale;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  let dataUrl = canvas.toDataURL('image/webp', 0.82);
  if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/png');
  return {
    dataUrl,
    width: canvas.width,
    height: canvas.height,
    trimmed: box.w < probe.width - 2 || box.h < probe.height - 2,
  };
}

// Arquivos soltos numa área de arrastar, incluindo pastas e subpastas.
export async function filesFromDrop(dataTransfer) {
  const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length === 0) return [...dataTransfer.files];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      out.push(await new Promise((resolve, reject) => entry.file(resolve, reject)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries devolve em lotes; chama até vir vazio
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const entry of entries) await walk(entry);
  return out;
}

export const isImageFile = (file) => /^image\//.test(file.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);

// Reduz a foto antes de guardar: o relatório precisa caber num envio por WhatsApp.
export async function compressImage(file, maxSide = 1280, quality = 0.72) {
  const img = await loadImage(file);
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}
