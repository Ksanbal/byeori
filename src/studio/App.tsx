import { Button } from '@/components/ui/button';

export function App() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
      <h1 className="text-2xl font-semibold">Byeori</h1>
      <Button size="sm" variant="outline" disabled>도구 설정 검증</Button>
    </main>
  );
}
