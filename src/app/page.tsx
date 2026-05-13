import { auth } from "@clerk/nextjs/server";
import { LandingHeader } from "@/components/LandingHeader";
import { LandingFooter } from "@/components/LandingFooter";
import { BriefPreview } from "@/components/BriefPreview";
import { Check, ArrowRight, Zap, Target, Sparkles, BarChart3, Users, Rocket } from "lucide-react";
import Link from "next/link";

export default async function LandingPage() {
  const { userId } = await auth();

  return (
    <div className="min-h-screen bg-background selection:bg-indigo-500/30">
      <LandingHeader />

      <main>
        {/* Hero Section */}
        <section className="relative pt-32 pb-20 overflow-hidden">
          <div className="hero-glow top-0 left-1/2 -translate-x-1/2" />
          <div className="grid-background absolute inset-0 -z-10" />
          
          <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col items-center text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs font-semibold mb-6 animate-fade-in-up">
              <Zap className="w-3 h-3 fill-indigo-400" />
              <span>New: Shopify Insight Engine 2.0</span>
            </div>
            
            <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-6 animate-fade-in-up-delay-1 max-w-4xl">
              Know exactly what to run on Meta. <span className="text-gradient">Before you spend.</span>
            </h1>
            
            <p className="text-lg md:text-xl text-foreground/60 mb-10 max-w-2xl animate-fade-in-up-delay-2">
              OmniTarget reads your Shopify store data and generates a perfect Meta Ads brief: audiences, creatives, and budget split. Built for high-growth DTC brands.
            </p>

            <div className="flex flex-col sm:flex-row gap-4 mb-16 animate-fade-in-up-delay-3">
              <Link 
                href={userId ? "/dashboard" : "/signup"}
                className="px-8 py-4 rounded-full bg-gradient-to-r from-indigo-600 to-violet-600 text-lg font-bold text-white shadow-glow hover:scale-105 transition-all flex items-center gap-2"
              >
                {userId ? "Go to Dashboard" : "Get Started for Free"}
                <ArrowRight className="w-5 h-5" />
              </Link>
              <a 
                href="#how-it-works"
                className="px-8 py-4 rounded-full bg-surface-raised border border-border-default text-lg font-bold hover:bg-surface-overlay transition-all"
              >
                See How it Works
              </a>
            </div>

            <div className="w-full flex justify-center px-4 animate-fade-in-up-delay-4">
              <BriefPreview />
            </div>
          </div>
        </section>

        {/* Features Grid */}
        <section id="features" className="py-24 bg-surface-raised/50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6">
            <div className="text-center mb-16">
              <h2 className="text-3xl md:text-4xl font-bold mb-4">The ultimate co-pilot for media buyers</h2>
              <p className="text-foreground/50 max-w-2xl mx-auto">
                Stop guessing and start scaling with data-driven insights pulled directly from your Shopify ecosystem.
              </p>
            </div>

            <div className="grid md:grid-cols-3 gap-8">
              {[
                {
                  title: "Smart Audience Discovery",
                  description: "We analyze your actual customer segments to find the most profitable interests and lookalikes.",
                  icon: Users
                },
                {
                  title: "Creative Direction",
                  description: "Know which product angles will convert based on purchase history and seasonal trends.",
                  icon: Sparkles
                },
                {
                  title: "Predictive Budgeting",
                  description: "Get the exact budget split recommended for prospecting vs retargeting campaigns.",
                  icon: BarChart3
                }
              ].map((feature, i) => (
                <div key={i} className="glass p-8 rounded-2xl border-white/5 hover:border-indigo-500/30 transition-all group">
                  <div className="w-12 h-12 rounded-xl bg-indigo-500/10 flex items-center justify-center text-indigo-400 mb-6 group-hover:scale-110 transition-transform">
                    <feature.icon className="w-6 h-6" />
                  </div>
                  <h3 className="text-xl font-bold mb-3">{feature.title}</h3>
                  <p className="text-foreground/50 text-sm leading-relaxed">{feature.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* How it Works */}
        <section id="how-it-works" className="py-24 relative overflow-hidden">
          <div className="hero-glow bottom-0 right-0 opacity-10" />
          <div className="max-w-5xl mx-auto px-4 sm:px-6">
            <div className="flex flex-col md:flex-row items-center gap-16">
              <div className="flex-1">
                <h2 className="text-4xl font-bold mb-8">From data to ads in under 60 seconds</h2>
                <div className="space-y-8">
                  {[
                    { step: 1, title: "Connect Shopify", text: "One-click secure integration. We read your orders and products in real-time." },
                    { step: 2, title: "AI Analysis", text: "Our Insight Engine identifies patterns, bestsellers, and high-LTV customer cohorts." },
                    { step: 3, title: "Export Brief", text: "Copy-paste your optimized campaign settings directly into Meta Ads Manager." }
                  ].map((s) => (
                    <div key={s.step} className="flex gap-6">
                      <div className="flex-shrink-0 w-10 h-10 rounded-full bg-indigo-600 flex items-center justify-center text-white font-bold shadow-glow">
                        {s.step}
                      </div>
                      <div>
                        <h4 className="text-xl font-bold mb-2">{s.title}</h4>
                        <p className="text-foreground/50">{s.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex-1 relative">
                <div className="aspect-square bg-gradient-to-br from-indigo-500/20 to-purple-600/20 rounded-3xl border border-white/10 p-1">
                  <div className="w-full h-full glass-raised rounded-2xl flex items-center justify-center">
                    <Rocket className="w-24 h-24 text-indigo-500 animate-pulse" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="py-24 bg-surface-raised">
          <div className="max-w-7xl mx-auto px-4 sm:px-6">
            <div className="text-center mb-16">
              <h2 className="text-4xl font-bold mb-4">Simple, transparent pricing</h2>
              <p className="text-foreground/50">No hidden fees. Scale as you grow.</p>
            </div>

            <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
              {[
                { name: "Starter", price: "$49", features: ["1 Shopify Store", "Weekly Brief", "Audience + Creative Angles", "Email Support"] },
                { name: "Growth", price: "$149", popular: true, features: ["1 Shopify Store", "Briefs on Demand", "Hero Products + Hooks", "Budget Split + Exclusions", "Priority Support"] },
                { name: "Scale", price: "$399", features: ["Up to 5 Stores", "Unlimited Briefs", "Custom Audience Rules", "Slack Delivery", "Dedicated Strategist"] }
              ].map((plan, i) => (
                <div key={i} className={`relative glass p-8 rounded-3xl border-white/5 flex flex-col ${plan.popular ? 'border-indigo-500/50 shadow-glow ring-2 ring-indigo-500/20' : ''}`}>
                  {plan.popular && (
                    <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-indigo-500 text-white text-[10px] font-bold px-4 py-1 rounded-full uppercase tracking-widest">
                      Most Popular
                    </div>
                  )}
                  <div className="mb-8">
                    <h3 className="text-xl font-bold mb-2">{plan.name}</h3>
                    <div className="flex items-baseline gap-1">
                      <span className="text-4xl font-extrabold">{plan.price}</span>
                      {plan.price !== "Custom" && <span className="text-foreground/40 text-sm">/mo</span>}
                    </div>
                  </div>
                  <ul className="space-y-4 mb-8 flex-1">
                    {plan.features.map((f) => (
                      <li key={f} className="flex items-center gap-3 text-sm text-foreground/70">
                        <Check className="w-4 h-4 text-indigo-400" />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <Link 
                    href="/signup"
                    className={`w-full py-3 rounded-xl text-center font-bold transition-all ${plan.popular ? 'bg-indigo-600 hover:bg-indigo-700 text-white' : 'bg-surface-overlay hover:bg-white/10 border border-white/10'}`}
                  >
                    Choose {plan.name}
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="py-24 relative overflow-hidden">
          <div className="hero-glow top-0 left-1/2 -translate-x-1/2 opacity-20" />
          <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center">
            <h2 className="text-4xl md:text-5xl font-bold mb-8">Ready to transform your Meta Ads performance?</h2>
            <p className="text-xl text-foreground/60 mb-10">
              Join 500+ Shopify brands using OmniTarget to scale their media buying.
            </p>
            <Link 
              href="/signup"
              className="inline-flex items-center gap-2 px-10 py-5 rounded-full bg-white text-black font-bold text-lg hover:scale-105 transition-all"
            >
              Get Started for Free
              <ArrowRight className="w-5 h-5" />
            </Link>
            <p className="mt-6 text-sm text-foreground/30">
              No credit card required. Connect your store in 30 seconds.
            </p>
          </div>
        </section>
      </main>

      <LandingFooter />
    </div>
  );
}
