import WorkPage, { TasksPage, SettingsEditor, WorkNav } from "./work-page.js";
import { lazy, Suspense, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Descriptions,
  Spin,
  Tag,
  Typography,
} from "antd";
import zhCN from "antd/locale/zh_CN";
import { readConfig } from "./api.js";
import "./style.css";

const MapPage = lazy(() => import("./map-page.js"));
const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: false } },
});
function Settings() {
  const query = useQuery({
    queryKey: ["config"],
    queryFn: ({ signal }) => readConfig(signal),
  });
  const config = query.data;
  return (
    <>
      <WorkNav />
      <main>
        <header>
          <Typography.Text className="brand">TRACKTOOL</Typography.Text>
          <Typography.Title level={1}>设置</Typography.Title>
          <Typography.Paragraph type="secondary">
            查看当前配置与轨迹分类。
          </Typography.Paragraph>
        </header>
        <Card
          title="当前配置"
          extra={
            <Button
              loading={query.isFetching}
              onClick={() => void query.refetch()}
            >
              刷新
            </Button>
          }
        >
          {query.isPending && (
            <div role="status">
              <Spin /> 正在读取配置…
            </div>
          )}
          {query.isError && (
            <Alert
              type="error"
              showIcon
              title="无法读取配置"
              description={query.error.message}
              action={
                <Button onClick={() => void query.refetch()}>重试</Button>
              }
            />
          )}
          {config && (
            <Descriptions
              column={1}
              items={[
                {
                  key: "archive",
                  label: "归档目录",
                  children: config.archive_path || "未设置",
                },
                { key: "level", label: "日志级别", children: config.log_level },
                {
                  key: "backup",
                  label: "备份目录名",
                  children: config.kml_backup_dir_name,
                },
                {
                  key: "key",
                  label: "Google API 密钥",
                  children: config.google_api_key_configured
                    ? "已配置"
                    : "未配置",
                },
              ]}
            />
          )}
        </Card>
        {config && (
          <Card title="轨迹分类">
            <Descriptions
              column={1}
              items={(
                [
                  ["Default", "默认"],
                  ["Train", "轨交"],
                  ["Flight", "飞行"],
                ] as const
              ).map(([category, label]) => ({
                key: category,
                label,
                children: (
                  <div className="tags">
                    {config[`track_tag.${category}`].map((name) => (
                      <Tag key={name}>{name}</Tag>
                    ))}
                  </div>
                ),
              }))}
            />
          </Card>
        )}
        <SettingsEditor refresh={() => void query.refetch()} />
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }}>
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Navigate to="/map" replace />} />
            <Route
              path="/map"
              element={
                <Suspense fallback={<Spin />}>
                  <MapPage />
                </Suspense>
              }
            />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="/archive"
              element={<WorkPage key="archive" group="archive" />}
            />
            <Route
              path="/tracks"
              element={<WorkPage key="tracks" group="tracks" />}
            />
            <Route
              path="/media"
              element={<WorkPage key="media" group="media" />}
            />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="*" element={<Navigate to="/map" replace />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ConfigProvider>
  </StrictMode>,
);
