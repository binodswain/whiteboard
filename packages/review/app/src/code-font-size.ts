import { createContext } from "react";

/** Web canvas code size, inherited by document code and read-only code peeks. */
export const CodeFontSizeContext = createContext<number | undefined>(undefined);
