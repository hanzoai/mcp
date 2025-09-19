'use client'

import React from 'react'
import { 
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Badge,
  Avatar,
  AvatarImage,
  AvatarFallback,
  Separator,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@hanzo/ui/primitives'
import {
  Container,
  Section,
  Grid,
  Flex,
  Stack,
  Text,
  Heading,
} from '@hanzo/ui/layout'
import {
  ArrowRight,
  Check,
  Star,
  Zap,
  Shield,
  Globe,
  Users,
  TrendingUp,
  ChevronRight,
  Sparkles,
  Rocket,
  Award,
} from 'lucide-react'
import { motion } from 'framer-motion'

const AwardWinningLandingPage = () => {
  // Animation variants
  const fadeInUp = {
    hidden: { opacity: 0, y: 20 },
    visible: { 
      opacity: 1, 
      y: 0,
      transition: { duration: 0.6, ease: 'easeOut' }
    }
  }

  const staggerChildren = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1
      }
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950">
      {/* Hero Section */}
      <Section className="relative pt-32 pb-24 overflow-hidden">
        {/* Background decoration */}
        <div className="absolute inset-0 bg-grid-white/[0.02] bg-[size:50px_50px]" />
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-purple-500/20 rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-blue-500/20 rounded-full blur-3xl" />
        
        <Container className="relative z-10">
          <motion.div
            initial="hidden"
            animate="visible"
            variants={fadeInUp}
            className="max-w-4xl mx-auto text-center"
          >
            <Badge className="mb-6 bg-gradient-to-r from-purple-600 to-blue-600 text-white border-0">
              <Sparkles className="w-3 h-3 mr-1" />
              Next Generation Platform
            </Badge>
            
            <Heading className="text-6xl md:text-7xl font-bold bg-gradient-to-r from-white via-purple-200 to-blue-200 bg-clip-text text-transparent mb-6">
              Build the Future with Confidence
            </Heading>
            
            <Text className="text-xl text-slate-400 mb-10 max-w-2xl mx-auto">
              Empower your team with cutting-edge tools and infrastructure that scales with your ambitions. 
              Join thousands of innovators already transforming their industries.
            </Text>
            
            <Flex className="gap-4 justify-center flex-wrap">
              <Button 
                size="lg" 
                className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 text-white px-8"
              >
                Get Started Free
                <ArrowRight className="ml-2 w-4 h-4" />
              </Button>
              <Button 
                size="lg" 
                variant="outline" 
                className="border-slate-700 text-slate-300 hover:bg-slate-800"
              >
                Watch Demo
              </Button>
            </Flex>
            
            <div className="mt-16 flex items-center justify-center gap-8 text-slate-400">
              <Flex className="items-center gap-2">
                <Users className="w-5 h-5" />
                <span className="font-semibold">50K+ Users</span>
              </Flex>
              <Flex className="items-center gap-2">
                <Star className="w-5 h-5 text-yellow-500" />
                <span className="font-semibold">4.9/5 Rating</span>
              </Flex>
              <Flex className="items-center gap-2">
                <Award className="w-5 h-5 text-purple-500" />
                <span className="font-semibold">Award Winning</span>
              </Flex>
            </div>
          </motion.div>
        </Container>
      </Section>

      {/* Features Grid */}
      <Section className="py-24 relative">
        <Container>
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={staggerChildren}
            className="text-center mb-16"
          >
            <Badge className="mb-4 bg-blue-500/10 text-blue-400 border-blue-500/20">
              Features
            </Badge>
            <Heading className="text-4xl md:text-5xl font-bold text-white mb-4">
              Everything You Need to Succeed
            </Heading>
            <Text className="text-lg text-slate-400 max-w-2xl mx-auto">
              Comprehensive tools and features designed to accelerate your growth
            </Text>
          </motion.div>

          <Grid className="grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {[
              {
                icon: <Zap className="w-6 h-6" />,
                title: "Lightning Fast",
                description: "Experience unparalleled speed with our optimized infrastructure that delivers results in milliseconds.",
                color: "from-yellow-500 to-orange-500"
              },
              {
                icon: <Shield className="w-6 h-6" />,
                title: "Enterprise Security",
                description: "Bank-grade encryption and security protocols keep your data safe and compliant with industry standards.",
                color: "from-green-500 to-emerald-500"
              },
              {
                icon: <Globe className="w-6 h-6" />,
                title: "Global Scale",
                description: "Deploy worldwide with our distributed network spanning 200+ locations across 6 continents.",
                color: "from-blue-500 to-cyan-500"
              },
              {
                icon: <Rocket className="w-6 h-6" />,
                title: "Rapid Deployment",
                description: "Go from idea to production in minutes with our streamlined deployment pipeline and automation tools.",
                color: "from-purple-500 to-pink-500"
              },
              {
                icon: <Users className="w-6 h-6" />,
                title: "Team Collaboration",
                description: "Built-in collaboration tools that keep your team aligned and productive, no matter where they are.",
                color: "from-indigo-500 to-purple-500"
              },
              {
                icon: <TrendingUp className="w-6 h-6" />,
                title: "Advanced Analytics",
                description: "Deep insights and real-time analytics help you make data-driven decisions with confidence.",
                color: "from-rose-500 to-pink-500"
              }
            ].map((feature, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
              >
                <Card className="bg-slate-900/50 border-slate-800 hover:border-slate-700 transition-all duration-300 h-full group hover:shadow-2xl hover:shadow-purple-500/10">
                  <CardHeader>
                    <div className={`w-12 h-12 rounded-lg bg-gradient-to-r ${feature.color} p-2.5 text-white mb-4 group-hover:scale-110 transition-transform`}>
                      {feature.icon}
                    </div>
                    <CardTitle className="text-xl text-white">{feature.title}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <CardDescription className="text-slate-400">
                      {feature.description}
                    </CardDescription>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </Grid>
        </Container>
      </Section>

      {/* Testimonials */}
      <Section className="py-24 bg-slate-900/50">
        <Container>
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={fadeInUp}
            className="text-center mb-16"
          >
            <Badge className="mb-4 bg-purple-500/10 text-purple-400 border-purple-500/20">
              Testimonials
            </Badge>
            <Heading className="text-4xl md:text-5xl font-bold text-white mb-4">
              Loved by Industry Leaders
            </Heading>
            <Text className="text-lg text-slate-400 max-w-2xl mx-auto">
              See what our customers have to say about their experience
            </Text>
          </motion.div>

          <Grid className="grid-cols-1 md:grid-cols-3 gap-8">
            {[
              {
                name: "Sarah Chen",
                role: "CTO at TechCorp",
                avatar: "SC",
                content: "This platform transformed how we build and deploy applications. The speed and reliability are unmatched.",
                rating: 5
              },
              {
                name: "Michael Rodriguez",
                role: "CEO at StartupX",
                avatar: "MR",
                content: "We scaled from 100 to 100,000 users seamlessly. The infrastructure just works, letting us focus on our product.",
                rating: 5
              },
              {
                name: "Emily Watson",
                role: "Head of Engineering at FinTech Pro",
                avatar: "EW",
                content: "Security and compliance were our top concerns. This platform exceeded all our expectations and requirements.",
                rating: 5
              }
            ].map((testimonial, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, scale: 0.9 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
              >
                <Card className="bg-slate-900/50 border-slate-800 h-full">
                  <CardHeader>
                    <Flex className="items-center gap-4 mb-4">
                      <Avatar>
                        <AvatarFallback className="bg-gradient-to-r from-purple-600 to-blue-600 text-white">
                          {testimonial.avatar}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <Text className="font-semibold text-white">{testimonial.name}</Text>
                        <Text className="text-sm text-slate-400">{testimonial.role}</Text>
                      </div>
                    </Flex>
                    <Flex className="gap-1 mb-4">
                      {[...Array(testimonial.rating)].map((_, i) => (
                        <Star key={i} className="w-4 h-4 fill-yellow-500 text-yellow-500" />
                      ))}
                    </Flex>
                  </CardHeader>
                  <CardContent>
                    <Text className="text-slate-300 italic">"{testimonial.content}"</Text>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </Grid>
        </Container>
      </Section>

      {/* Pricing Cards */}
      <Section className="py-24">
        <Container>
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={fadeInUp}
            className="text-center mb-16"
          >
            <Badge className="mb-4 bg-green-500/10 text-green-400 border-green-500/20">
              Pricing
            </Badge>
            <Heading className="text-4xl md:text-5xl font-bold text-white mb-4">
              Simple, Transparent Pricing
            </Heading>
            <Text className="text-lg text-slate-400 max-w-2xl mx-auto">
              Choose the perfect plan for your needs. Always flexible to scale
            </Text>
          </motion.div>

          <Grid className="grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
            {[
              {
                name: "Starter",
                price: "$29",
                period: "per month",
                description: "Perfect for small teams getting started",
                features: [
                  "Up to 10 team members",
                  "5GB storage",
                  "Basic analytics",
                  "Email support",
                  "API access"
                ],
                popular: false
              },
              {
                name: "Professional",
                price: "$99",
                period: "per month",
                description: "For growing teams that need more power",
                features: [
                  "Unlimited team members",
                  "100GB storage",
                  "Advanced analytics",
                  "Priority support",
                  "Full API access",
                  "Custom integrations",
                  "SSO authentication"
                ],
                popular: true
              },
              {
                name: "Enterprise",
                price: "Custom",
                period: "contact sales",
                description: "Tailored solutions for large organizations",
                features: [
                  "Everything in Pro",
                  "Unlimited storage",
                  "Dedicated support",
                  "Custom SLA",
                  "On-premise option",
                  "Advanced security",
                  "Compliance reports"
                ],
                popular: false
              }
            ].map((plan, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                className={plan.popular ? 'relative' : ''}
              >
                {plan.popular && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2 z-10">
                    <Badge className="bg-gradient-to-r from-purple-600 to-blue-600 text-white border-0">
                      Most Popular
                    </Badge>
                  </div>
                )}
                <Card className={`h-full ${
                  plan.popular 
                    ? 'bg-gradient-to-b from-purple-900/20 to-slate-900/50 border-purple-500/50' 
                    : 'bg-slate-900/50 border-slate-800'
                } hover:border-slate-700 transition-all duration-300`}>
                  <CardHeader className="text-center pb-8">
                    <CardTitle className="text-2xl text-white mb-2">{plan.name}</CardTitle>
                    <CardDescription className="text-slate-400 mb-4">
                      {plan.description}
                    </CardDescription>
                    <div className="text-center">
                      <span className="text-5xl font-bold text-white">{plan.price}</span>
                      <span className="text-slate-400 ml-2">/{plan.period}</span>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <Stack className="gap-3">
                      {plan.features.map((feature, i) => (
                        <Flex key={i} className="items-center gap-3">
                          <Check className="w-5 h-5 text-green-500 flex-shrink-0" />
                          <Text className="text-slate-300">{feature}</Text>
                        </Flex>
                      ))}
                    </Stack>
                  </CardContent>
                  <CardFooter>
                    <Button 
                      className={`w-full ${
                        plan.popular 
                          ? 'bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 text-white' 
                          : 'bg-slate-800 hover:bg-slate-700 text-white'
                      }`}
                      size="lg"
                    >
                      {plan.name === 'Enterprise' ? 'Contact Sales' : 'Get Started'}
                      <ChevronRight className="ml-2 w-4 h-4" />
                    </Button>
                  </CardFooter>
                </Card>
              </motion.div>
            ))}
          </Grid>
        </Container>
      </Section>

      {/* CTA Section */}
      <Section className="py-32 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-purple-900/20 via-blue-900/20 to-purple-900/20" />
        <Container className="relative z-10">
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={fadeInUp}
            className="max-w-4xl mx-auto text-center"
          >
            <Badge className="mb-6 bg-gradient-to-r from-purple-600 to-blue-600 text-white border-0">
              <Rocket className="w-3 h-3 mr-1" />
              Start Today
            </Badge>
            
            <Heading className="text-5xl md:text-6xl font-bold text-white mb-6">
              Ready to Transform Your Business?
            </Heading>
            
            <Text className="text-xl text-slate-400 mb-10 max-w-2xl mx-auto">
              Join thousands of companies already using our platform to build amazing products. 
              Start your free trial today, no credit card required.
            </Text>
            
            <Flex className="gap-4 justify-center flex-wrap">
              <Button 
                size="lg" 
                className="bg-white text-slate-900 hover:bg-slate-100 px-8"
              >
                Start Free Trial
                <ArrowRight className="ml-2 w-4 h-4" />
              </Button>
              <Button 
                size="lg" 
                variant="outline" 
                className="border-slate-700 text-slate-300 hover:bg-slate-800"
              >
                Schedule Demo
              </Button>
            </Flex>
            
            <Text className="mt-8 text-sm text-slate-500">
              No credit card required • 14-day free trial • Cancel anytime
            </Text>
          </motion.div>
        </Container>
      </Section>

      {/* Footer */}
      <footer className="py-12 border-t border-slate-800">
        <Container>
          <Flex className="justify-between items-center flex-wrap gap-4">
            <Text className="text-slate-400">
              © 2024 Your Company. All rights reserved.
            </Text>
            <Flex className="gap-6">
              <a href="#" className="text-slate-400 hover:text-white transition-colors">
                Privacy
              </a>
              <a href="#" className="text-slate-400 hover:text-white transition-colors">
                Terms
              </a>
              <a href="#" className="text-slate-400 hover:text-white transition-colors">
                Contact
              </a>
            </Flex>
          </Flex>
        </Container>
      </footer>
    </div>
  )
}

export default AwardWinningLandingPage