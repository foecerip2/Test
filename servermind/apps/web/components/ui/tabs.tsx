"use client";

import * as T from "@radix-ui/react-tabs";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

export const Tabs = T.Root;

export function TabsList({ className, ...props }: ComponentPropsWithoutRef<typeof T.List>) {
  return (
    <T.List
      className={cn("inline-flex w-full max-w-full gap-1 rounded-control border border-stroke bg-canvas p-1 sm:w-auto", className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentPropsWithoutRef<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        "inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-[8px] px-4 text-sm font-medium text-text-secondary transition-colors duration-120 hover:text-text data-[state=active]:bg-elevated data-[state=active]:text-text sm:flex-none",
        className,
      )}
      {...props}
    />
  );
}

export const TabsContent = T.Content;
