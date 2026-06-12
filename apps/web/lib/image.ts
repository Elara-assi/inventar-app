/**
 * Clientseitige Foto-Kompression (O3): max. 1600 px, JPEG ~0.8.
 * Haelt die Outbox klein (500 Objekte x 3 Fotos ~ 0,5 GB) und beschleunigt
 * den Sync ueber LTE. Faellt bei Fehlern auf das Original zurueck.
 */
export async function compressImage(file: File, maxDim = 1600, quality = 0.8): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1 && file.size < 800 * 1024) {
      bitmap.close();
      return file;
    }
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch {
    return file;
  }
}
