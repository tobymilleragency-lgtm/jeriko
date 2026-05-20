import { Button } from "@/components/ui/button";
import { APP_LOGO, APP_TITLE } from "@/const";

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="w-full border-b px-4 flex items-center justify-between h-16">
        <div className="flex items-center gap-2">
          <img src={APP_LOGO} alt="" className="h-8 w-8 rounded-lg border-border bg-background object-cover" />
          <span className="text-xl font-bold">{APP_TITLE}</span>
        </div>
        <a href="#quote" className="text-sm font-medium text-primary">Request quote</a>
      </header>
      <main>
        <section className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl items-center gap-10 px-6 py-16 md:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-6">
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-primary">Local service website</p>
            <h1 className="text-5xl font-bold tracking-tight md:text-7xl">{APP_TITLE}</h1>
            <p className="text-xl leading-8 text-muted-foreground">
              A launch-ready service business landing page with clear positioning, conversion paths, crawler-visible content, and image prompts for realistic website photos.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg"><a href="#quote">Request a quote</a></Button>
              <Button asChild variant="outline" size="lg"><a href="#services">View services</a></Button>
            </div>
          </div>
          <div className="rounded-3xl border bg-muted/40 p-6 shadow-sm">
            <h2 className="text-2xl font-semibold">Built for search and conversion</h2>
            <ul className="mt-5 space-y-3 text-muted-foreground">
              <li>• Service sections and quote CTA ready for local SEO expansion</li>
              <li>• Generated image prompts for hero, service, and social preview assets</li>
              <li>• Verification gates for crawler HTML, metadata, route, and browser smoke</li>
            </ul>
          </div>
        </section>
        <section id="services" className="mx-auto max-w-6xl px-6 pb-12">
          <h2 className="text-3xl font-semibold">Services</h2>
          <p className="mt-3 max-w-3xl text-muted-foreground">
            Replace this section with the real services, cities, proof, FAQs, reviews, and calls to action for the business.
          </p>
        </section>
        <section id="quote" className="mx-auto max-w-6xl px-6 pb-16">
          <div className="rounded-3xl border p-6">
            <h2 className="text-3xl font-semibold">Start the conversation</h2>
            <p className="mt-3 text-muted-foreground">Connect this CTA to the quote form, booking flow, phone number, or CRM endpoint.</p>
          </div>
        </section>
      </main>
    </div>
  );
}
