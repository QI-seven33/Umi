import { fileFormat } from './file-format.js';
export function FileIcon({ path }: { path: string }) {
  return <img className="file-type-icon" src={`./file-icons/${fileFormat(path).icon}.svg`} width="16" height="16" alt="" aria-hidden="true" draggable={false} />;
}
