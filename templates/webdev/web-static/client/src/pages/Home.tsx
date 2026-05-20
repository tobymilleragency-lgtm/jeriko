import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex min-h-screen max-w-6xl flex-col justify-center gap-10 px-6 py-16">
        <div className="max-w-3xl space-y-6">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-primary">Launch-ready web app</p>
          <h1 className="text-5xl font-bold tracking-tight md:text-7xl">{{project_title}}</h1>
          <p className="text-xl leading-8 text-muted-foreground">
            A production starter for a real customer-facing site: clear positioning, conversion paths, crawlable content, and room for the agent to build the actual product without demo residue.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg"><a href="#contact">Start the project</a></Button>
            <Button asChild variant="outline" size="lg"><a href="#services">View services</a></Button>
          </div>
        </div>

        <section id="services" className="grid gap-4 md:grid-cols-3">
          {[
            ["Plan", "Map the offer, users, pages, data, and launch requirements before writing code."],
            ["Build", "Ship a responsive interface with accessible components, real forms, and practical empty states."],
            ["Verify", "Run install, typecheck, build, crawler HTML, route, and browser smoke gates before calling it done."],
          ].map(([title, body]) => (
            <article key={title} className="rounded-2xl border bg-card p-6 shadow-sm">
              <h2 className="text-xl font-semibold">{title}</h2>
              <p className="mt-3 leading-7 text-muted-foreground">{body}</p>
            </article>
          ))}
        </section>

        <section id="contact" className="rounded-3xl border bg-muted/40 p-6 md:p-8">
          <h2 className="text-2xl font-semibold">Ready for real content</h2>
          <p className="mt-3 max-w-3xl leading-7 text-muted-foreground">
            Replace this starter with business-specific sections, proof, calls to action, and generated imagery. Keep every public route crawlable and every conversion target measurable.
          </p>
        </section>
      </section>
    </main>
  );
}
