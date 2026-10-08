import { startWebCanvas } from "./web-app";

const root = document.querySelector<HTMLElement>("#root");

if (!root) throw new Error("The web canvas needs a #root element.");

startWebCanvas(root);
