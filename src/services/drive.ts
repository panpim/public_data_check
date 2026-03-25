import { google } from "googleapis";
import { Readable } from "stream";

/**
 * Extract the folder ID from a Google Drive folder URL.
 * Accepted formats:
 *   https://drive.google.com/drive/folders/<id>
 *   https://drive.google.com/drive/u/0/folders/<id>
 */
export function extractFolderIdFromUrl(url: string): string | null {
  const match = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Upload a PDF buffer to a specific Google Drive folder.
 * Uses the end-user's OAuth access token (drive.file scope).
 */
export async function uploadFileToDrive(
  accessToken: string,
  folderId: string,
  filename: string,
  pdfBuffer: Buffer
): Promise<{ fileId: string; webViewLink: string }> {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

  const drive = google.drive({ version: "v3", auth });

  const response = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
      mimeType: "application/pdf",
    },
    media: {
      mimeType: "application/pdf",
      body: Readable.from(pdfBuffer),
    },
    fields: "id,webViewLink",
  });

  if (!response.data.id || !response.data.webViewLink) {
    throw new Error("Drive upload succeeded but returned no file ID or URL");
  }

  return {
    fileId: response.data.id,
    webViewLink: response.data.webViewLink,
  };
}
