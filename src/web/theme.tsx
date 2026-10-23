import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";

type Theme = "light" | "dark" | "system";
type Appearance = Exclude<Theme, "system">;
const storageKey = "tracktool:theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
const ThemeContext = createContext<{
  theme: Theme;
  appearance: Appearance;
  setTheme: (theme: Theme) => void;
} | null>(null);

function readTheme(): Theme {
  try {
    const value = localStorage.getItem(storageKey);
    if (value === "light" || value === "dark") return value;
  } catch {
    // A browser that blocks storage can still use the system preference.
  }
  return "system";
}

function applyAppearance(appearance: Appearance) {
  document.documentElement.classList.toggle("dark", appearance === "dark");
  document.documentElement.style.colorScheme = appearance;
}

// Apply the preference before React renders the startup screen.
export function initializeTheme() {
  const theme = readTheme();
  applyAppearance(
    theme === "system" ? (media.matches ? "dark" : "light") : theme,
  );
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState(readTheme);
  const [systemDark, setSystemDark] = useState(media.matches);
  const appearance =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;
  useLayoutEffect(() => applyAppearance(appearance), [appearance]);
  useEffect(() => {
    const onSystemChange = () => setSystemDark(media.matches);
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null)
        updateTheme(readTheme());
    };
    onSystemChange();
    media.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const setTheme = (value: Theme) => {
    updateTheme(value);
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      // Keep the selected theme usable for this session even without storage.
    }
  };
  return (
    <ThemeContext.Provider value={{ theme, appearance, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("配色设置尚未初始化");
  return theme;
}
