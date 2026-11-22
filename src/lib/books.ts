// Books from book sources: download the whole file, import it as chapters.
import { addBook } from "./api";
import { addImportedNovel } from "./db";

export async function addBookToLibrary(sourceId: string, bookUrl: string): Promise<number> {
  const { novel, details, file_path } = await addBook(sourceId, bookUrl);
  return addImportedNovel(novel, {
    sourceId,
    novelUrl: bookUrl,
    title: details.title,
    author: details.author,
    coverUrl: details.cover_url,
    summary: details.summary,
    bookFile: file_path,
  });
}
