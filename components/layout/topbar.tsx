import { Bell } from "lucide-react";
import { Logo } from "./logo";
import { Button } from "@/components/ui/button";
import { PoSearch } from "./po-search";

export function Topbar({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="sticky top-0 z-30 flex h-[68px] items-center gap-4 border-b border-border/60 bg-canvas/80 px-5 backdrop-blur-md lg:px-8">
      <div className="lg:hidden">
        <Logo variant="dark" />
      </div>
      <div className="hidden min-w-0 lg:block">
        <h1 className="truncate text-[19px] font-semibold tracking-tight">{title}</h1>
        {subtitle && (
          <p className="truncate text-[13px] text-muted-foreground">{subtitle}</p>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <PoSearch />
        <Button variant="outline" size="icon" className="relative">
          <Bell className="h-[18px] w-[18px]" />
          <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-danger" />
        </Button>
      </div>
    </header>
  );
}
