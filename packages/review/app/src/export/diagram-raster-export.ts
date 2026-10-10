export type DiagramRasterOptions = {
  theme: "light" | "dark";
  border: "none" | "frame" | "rounded";
};

function copyComputedStyles(source: Element, target: Element) {
  const computed = getComputedStyle(source);

  const style =
    target instanceof HTMLElement || target instanceof SVGElement
      ? target.style
      : null;

  if (!style) return;

  for (let index = 0; index < computed.length; index += 1) {
    const property = computed.item(index);
    style.setProperty(property, computed.getPropertyValue(property));
  }

  const sourceChildren = source.children;
  const targetChildren = target.children;

  for (let index = 0; index < sourceChildren.length; index += 1) {
    const sourceChild = sourceChildren.item(index);
    const targetChild = targetChildren.item(index);

    if (sourceChild && targetChild)
      copyComputedStyles(sourceChild, targetChild);
  }
}

function blobFromCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not create PNG image"));
    }, "image/png");
  });
}

export async function renderDiagramPng(
  source: HTMLElement,
  options: DiagramRasterOptions,
): Promise<Blob> {
  const width = Math.max(source.scrollWidth, source.clientWidth, 1);
  const height = Math.max(source.scrollHeight, source.clientHeight, 1);
  const host = document.createElement("div");
  host.className = `review-app review-app--theme-${options.theme}`;
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;overflow:hidden;`;
  // SAFETY: source is an HTMLElement, and deep cloning preserves its element type.
  const clone = source.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll("button,[role=button],[data-diagram-export-ui]")
    .forEach((element) => element.remove());
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  host.append(clone);
  document.body.append(host);

  try {
    clone.style.width = `${width}px`;
    clone.style.height = `${height}px`;
    // SAFETY: clone is an HTMLElement, so its deep clone remains an HTMLElement.
    const visualClone = clone.cloneNode(true) as HTMLElement;
    copyComputedStyles(clone, visualClone);
    const padding = options.border === "none" ? 0 : 20;
    const output = document.createElement("div");
    output.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    output.style.cssText = `box-sizing:border-box;width:${width + padding * 2}px;height:${height + padding * 2}px;padding:${padding}px;background:${options.border === "none" ? "transparent" : "#ffffff"};overflow:hidden;`;

    if (options.border !== "none") {
      output.style.border = "1px solid #d8dbe1";
      output.style.background =
        options.theme === "dark" ? "#0c0f15" : "#ffffff";
    }

    if (options.border === "rounded") output.style.borderRadius = "16px";

    output.append(visualClone);

    const markup = new XMLSerializer().serializeToString(output);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width + padding * 2}" height="${height + padding * 2}" viewBox="0 0 ${width + padding * 2} ${height + padding * 2}"><foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
    const image = new Image();

    const imageUrl = URL.createObjectURL(
      new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
    );

    try {
      image.src = imageUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = width + padding * 2;
      canvas.height = height + padding * 2;
      const context = canvas.getContext("2d");

      if (!context) throw new Error("Canvas is unavailable");

      context.drawImage(image, 0, 0);

      return await blobFromCanvas(canvas);
    } finally {
      URL.revokeObjectURL(imageUrl);
    }
  } finally {
    host.remove();
  }
}
