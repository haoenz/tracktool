import { lazy, Suspense, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfigProvider, Spin } from "antd";
import zhCN from "antd/locale/zh_CN";
import "./style.css";
const MapPage = lazy(() => import("./map-page.js"));
const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: false } },
});
function LegacyPanel({ panel }: { panel: string }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("panel", panel);
  return <Navigate to={"/map?" + params.toString()} replace />;
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }}>
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <Routes>
            <Route
              path="/map"
              element={
                <Suspense fallback={<Spin />}>
                  <MapPage />
                </Suspense>
              }
            />
            {["archive", "tracks", "tasks", "settings"].map((panel) => (
              <Route
                key={panel}
                path={"/" + panel}
                element={<LegacyPanel panel={panel} />}
              />
            ))}
            <Route path="*" element={<Navigate to="/map" replace />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ConfigProvider>
  </StrictMode>,
);
