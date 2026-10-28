"use client";

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "../../theme.js";

const Toaster = ({ ...props }: ToasterProps) => {
  const { appearance } = useTheme();
  return (
    <Sonner
      theme={appearance}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
      offset={props.offset ?? { top: 84, right: 16, bottom: 24, left: 16 }}
      mobileOffset={
        props.mobileOffset ?? { top: 132, right: 16, bottom: 24, left: 16 }
      }
      toastOptions={{
        ...props.toastOptions,
        // Status messages must not intercept map navigation or pause on hover.
        style: { ...props.toastOptions?.style, pointerEvents: "none" },
        actionButtonStyle: {
          ...props.toastOptions?.actionButtonStyle,
          pointerEvents: "auto",
        },
        cancelButtonStyle: {
          ...props.toastOptions?.cancelButtonStyle,
          pointerEvents: "auto",
        },
        classNames: {
          ...props.toastOptions?.classNames,
          closeButton: `pointer-events-auto ${props.toastOptions?.classNames?.closeButton ?? ""}`,
        },
      }}
    />
  );
};

export { Toaster };
