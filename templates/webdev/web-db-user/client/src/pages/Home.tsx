import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { getLoginUrl } from "@/const";

export default function Home() {
  const { user, loading, error, isAuthenticated, logout } = useAuth();

  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex min-h-screen max-w-6xl flex-col justify-center gap-10 px-6 py-16">
        <div className="max-w-3xl space-y-6">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-primary">Launch-ready app portal</p>
          <h1 className="text-5xl font-bold tracking-tight md:text-7xl">{{project_title}}</h1>
          <p className="text-xl leading-8 text-muted-foreground">
            A secure full-stack starter with authentication state, API room, database wiring, and production gates built in from the first screen.
          </p>
          <div className="flex flex-wrap gap-3">
            {loading ? (
              <Button size="lg" disabled>Checking session...</Button>
            ) : isAuthenticated ? (
              <>
                <Button size="lg">Open dashboard</Button>
                <Button variant="outline" size="lg" onClick={() => void logout()}>Sign out</Button>
              </>
            ) : (
              <Button asChild size="lg"><a href={getLoginUrl()}>Sign in</a></Button>
            )}
          </div>
          {error ? <p className="text-sm text-destructive">{String(error)}</p> : null}
          {user?.email ? <p className="text-sm text-muted-foreground">Signed in as {user.email}</p> : null}
        </div>

        <section className="grid gap-4 md:grid-cols-3">
          {[
            ["Authenticated", "Use the provided auth hook to protect account workflows and role-specific views."],
            ["Database-ready", "Extend the Drizzle schema and server routes around source-of-truth records, not temporary UI state."],
            ["Verified", "Install, check, build, route, browser, and crawler gates are part of the default delivery contract."],
          ].map(([title, body]) => (
            <article key={title} className="rounded-2xl border bg-card p-6 shadow-sm">
              <h2 className="text-xl font-semibold">{title}</h2>
              <p className="mt-3 leading-7 text-muted-foreground">{body}</p>
            </article>
          ))}
        </section>
      </section>
    </main>
  );
}
