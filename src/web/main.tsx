import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { StartupScreen } from "./components/startup-screen.js";
import { Toaster } from "./components/ui/sonner.js";
import "./style.css";
import { initializeTheme, ThemeProvider } from "./theme.js";
const MapPage = lazy(() => import("./map-page.js"));
const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: false,
      // Returning to the tab should preserve the current detail/editor view.
      refetchOnWindowFocus: false,
    },
  },
});
initializeTheme();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <Toaster
        position="top-right"
        visibleToasts={1}
        containerAriaLabel="通知"
      />
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <Routes>
            <Route
              path="/map"
              element={
                <Suspense fallback={<StartupScreen />}>
                  <MapPage />
                </Suspense>
              }
            />

            <Route path="/" element={<Navigate to="/map" replace />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
