interface PwaUploadBridge {
  uploadBrowserFiles?(files: File[]): Promise<string[]>;
}

function pwaBridge(): PwaUploadBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as typeof window & { __GSAP_PWA__?: PwaUploadBridge }).__GSAP_PWA__;
}

export interface ResolvedBrowserFiles {
  paths: string[];
  nameMap: Record<string, string>;
}

export async function resolveBrowserFilePaths(files: File[]): Promise<ResolvedBrowserFiles> {
  const paths: string[] = [];
  const nameMap: Record<string, string> = {};
  const uploadFiles: File[] = [];

  for (const file of files) {
    const nativePath = window.platform?.getFilePath?.(file)
      || (file as File & { path?: string })?.path
      || null;
    if (nativePath) {
      paths.push(nativePath);
      nameMap[nativePath] = file.name;
    } else {
      uploadFiles.push(file);
    }
  }

  if (uploadFiles.length > 0) {
    const uploadedPaths = await pwaBridge()?.uploadBrowserFiles?.(uploadFiles) || [];
    uploadedPaths.forEach((filePath, index) => {
      if (!filePath) return;
      paths.push(filePath);
      nameMap[filePath] = uploadFiles[index]?.name || filePath.split(/[\\/]/).pop() || filePath;
    });
  }

  return { paths, nameMap };
}
