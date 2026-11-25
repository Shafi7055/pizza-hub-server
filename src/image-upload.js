export function isSupportedImage(file) {
  const buffer = file.buffer;
  if (!Buffer.isBuffer(buffer)) return false;

  if (file.mimetype === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (file.mimetype === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (file.mimetype === "image/gif") {
    const signature = buffer.toString("ascii", 0, 6);
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (file.mimetype === "image/webp") {
    return buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP";
  }
  return false;
}

export async function uploadImageToImgBB(file, apiKey) {
  const form = new FormData();
  form.append("image", new Blob([file.buffer], { type: file.mimetype }));

  const endpoint = new URL("https://api.imgbb.com/1/upload");
  endpoint.searchParams.set("key", apiKey);

  let response;
  try {
    response = await fetch(endpoint, { method: "POST", body: form });
  } catch {
    throw new Error("ImgBB could not be reached");
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("ImgBB returned an invalid response");
  }

  const imageUrl = result?.data?.display_url || result?.data?.url;
  if (!response.ok || !result?.success || typeof imageUrl !== "string") {
    throw new Error("ImgBB rejected the image upload");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    throw new Error("ImgBB returned an invalid image URL");
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error("ImgBB returned an invalid image URL");
  }

  return parsedUrl.toString();
}
