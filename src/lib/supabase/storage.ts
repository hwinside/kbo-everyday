import { supabase } from "./client";

const BUCKET = "photos";

export async function uploadImage(file: File, folder: string = "posts"): Promise<string | null> {
  const ext = file.name.split(".").pop() || "jpg";
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type,
    });

  if (error) {
    console.error("Upload error:", error);
    return null;
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export async function uploadImages(files: File[], folder: string = "posts"): Promise<string[]> {
  const results = await Promise.all(files.map(f => uploadImage(f, folder)));
  return results.filter(Boolean) as string[];
}
