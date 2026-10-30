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

// Reduz a foto antes de guardar: o relatório precisa caber num envio por WhatsApp.
export function compressImage(file, maxSide = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Não foi possível ler a imagem.'));
    };
    img.src = url;
  });
}
