"""Tool personality system for organizing development tools based on famous programmers."""

import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Set


@dataclass
class ToolPersonality:
    """Represents a programmer personality with tool preferences."""
    name: str
    programmer: str
    description: str
    tools: List[str]
    environment: Optional[Dict[str, str]] = None
    philosophy: Optional[str] = None
    
    def __post_init__(self):
        """Validate personality configuration."""
        if not self.name:
            raise ValueError("Personality name is required")
        if not self.tools:
            raise ValueError("Personality must include at least one tool")


class PersonalityRegistry:
    """Registry for tool personalities."""
    
    _personalities: Dict[str, ToolPersonality] = {}
    _active_personality: Optional[str] = None
    
    @classmethod
    def register(cls, personality: ToolPersonality) -> None:
        """Register a tool personality."""
        cls._personalities[personality.name] = personality
    
    @classmethod
    def get(cls, name: str) -> Optional[ToolPersonality]:
        """Get a personality by name."""
        return cls._personalities.get(name)
    
    @classmethod
    def list(cls) -> List[ToolPersonality]:
        """List all registered personalities."""
        return list(cls._personalities.values())
    
    @classmethod
    def set_active(cls, name: str) -> None:
        """Set the active personality."""
        if name not in cls._personalities:
            raise ValueError(f"Personality '{name}' not found")
        cls._active_personality = name
    
    @classmethod
    def get_active(cls) -> Optional[ToolPersonality]:
        """Get the active personality."""
        if cls._active_personality:
            return cls._personalities.get(cls._active_personality)
        return None
    
    @classmethod
    def get_active_tools(cls) -> Set[str]:
        """Get the set of tools from the active personality."""
        personality = cls.get_active()
        if personality:
            return set(personality.tools)
        return set()


# Essential tools that are always available
ESSENTIAL_TOOLS = ["read", "write", "edit", "tree", "bash", "think"]

# Common tool sets for reuse
UNIX_TOOLS = ["grep", "find_files", "bash", "process", "diff"]
BUILD_TOOLS = ["bash", "npx", "uvx", "process"]
VERSION_CONTROL = ["git_search", "diff"]
AI_TOOLS = ["agent", "consensus", "critic", "think"]
SEARCH_TOOLS = ["search", "symbols", "grep", "git_search"]
DATABASE_TOOLS = ["sql_query", "sql_search", "graph_add", "graph_query"]
VECTOR_TOOLS = ["vector_index", "vector_search"]

# 100 Programmer Personalities
personalities = [
    # 1-10: Language Creators
    ToolPersonality(
        name="guido",
        programmer="Guido van Rossum",
        description="Python's BDFL - readability counts",
        philosophy="There should be one-- and preferably only one --obvious way to do it.",
        tools=ESSENTIAL_TOOLS + ["uvx", "jupyter", "multi_edit", "symbols", "rules"] + AI_TOOLS + SEARCH_TOOLS,
        environment={"PYTHONPATH": ".", "PYTEST_ARGS": "-xvs"}
    ),
    ToolPersonality(
        name="matz",
        programmer="Yukihiro Matsumoto",
        description="Ruby creator - optimize for developer happiness",
        philosophy="Ruby is designed to make programmers happy.",
        tools=ESSENTIAL_TOOLS + ["npx", "symbols", "batch", "todo"] + SEARCH_TOOLS,
        environment={"RUBY_VERSION": "3.0", "BUNDLE_PATH": "vendor/bundle"}
    ),
    ToolPersonality(
        name="brendan",
        programmer="Brendan Eich",
        description="JavaScript creator - dynamic and flexible",
        philosophy="Always bet on JS.",
        tools=ESSENTIAL_TOOLS + ["npx", "watch", "symbols", "todo", "rules"] + BUILD_TOOLS + SEARCH_TOOLS,
        environment={"NODE_ENV": "development", "NPM_CONFIG_LOGLEVEL": "warn"}
    ),
    ToolPersonality(
        name="dennis",
        programmer="Dennis Ritchie",
        description="C creator - close to the metal",
        philosophy="UNIX is basically a simple operating system, but you have to be a genius to understand the simplicity.",
        tools=ESSENTIAL_TOOLS + ["symbols", "content_replace"] + UNIX_TOOLS,
        environment={"CC": "gcc", "CFLAGS": "-Wall -O2"}
    ),
    ToolPersonality(
        name="bjarne",
        programmer="Bjarne Stroustrup",
        description="C++ creator - zero-overhead abstractions",
        philosophy="C++ is designed to allow you to express ideas.",
        tools=ESSENTIAL_TOOLS + ["symbols", "multi_edit", "content_replace"] + UNIX_TOOLS + BUILD_TOOLS,
        environment={"CXX": "g++", "CXXFLAGS": "-std=c++20 -Wall"}
    ),
    ToolPersonality(
        name="james",
        programmer="James Gosling",
        description="Java creator - write once, run anywhere",
        philosophy="Java is C++ without the guns, knives, and clubs.",
        tools=ESSENTIAL_TOOLS + ["symbols", "batch", "todo"] + BUILD_TOOLS,
        environment={"JAVA_HOME": "/usr/lib/jvm/java-11-openjdk"}
    ),
    ToolPersonality(
        name="anders",
        programmer="Anders Hejlsberg",
        description="TypeScript/C# creator - type safety matters",
        philosophy="TypeScript is JavaScript that scales.",
        tools=ESSENTIAL_TOOLS + ["npx", "symbols", "watch", "rules"] + BUILD_TOOLS + SEARCH_TOOLS,
        environment={"TYPESCRIPT_VERSION": "5.0"}
    ),
    ToolPersonality(
        name="larry",
        programmer="Larry Wall",
        description="Perl creator - there's more than one way to do it",
        philosophy="The three chief virtues of a programmer are laziness, impatience, and hubris.",
        tools=ESSENTIAL_TOOLS + ["grep", "content_replace", "batch"] + UNIX_TOOLS,
        environment={"PERL5LIB": "./lib"}
    ),
    ToolPersonality(
        name="rasmus",
        programmer="Rasmus Lerdorf",
        description="PHP creator - pragmatic web development",
        philosophy="I'm not a real programmer. I throw together things until it works.",
        tools=ESSENTIAL_TOOLS + ["npx", "sql_query", "watch"] + DATABASE_TOOLS,
        environment={"PHP_VERSION": "8.0"}
    ),
    ToolPersonality(
        name="rich",
        programmer="Rich Hickey",
        description="Clojure creator - simplicity matters",
        philosophy="Programming is not about typing... it's about thinking.",
        tools=ESSENTIAL_TOOLS + ["symbols", "todo", "batch"] + AI_TOOLS,
        environment={"CLOJURE_VERSION": "1.11"}
    ),
    
    # 11-20: Systems & Infrastructure
    ToolPersonality(
        name="linus",
        programmer="Linus Torvalds",
        description="Linux & Git creator - pragmatic excellence",
        philosophy="Talk is cheap. Show me the code.",
        tools=ESSENTIAL_TOOLS + ["git_search", "diff", "content_replace", "critic"] + UNIX_TOOLS,
        environment={"KERNEL_VERSION": "6.0", "GIT_AUTHOR_NAME": "Linus Torvalds"}
    ),
    ToolPersonality(
        name="rob",
        programmer="Rob Pike",
        description="Go creator - simplicity and concurrency",
        philosophy="A little copying is better than a little dependency.",
        tools=ESSENTIAL_TOOLS + ["symbols", "batch", "process"] + UNIX_TOOLS + BUILD_TOOLS,
        environment={"GOPATH": "~/go", "GO111MODULE": "on"}
    ),
    ToolPersonality(
        name="ken",
        programmer="Ken Thompson",
        description="Unix creator - elegant minimalism",
        philosophy="When in doubt, use brute force.",
        tools=ESSENTIAL_TOOLS + UNIX_TOOLS,
        environment={"PATH": "/usr/local/bin:$PATH"}
    ),
    ToolPersonality(
        name="bill",
        programmer="Bill Joy",
        description="Vi creator & BSD contributor",
        philosophy="The best way to predict the future is to invent it.",
        tools=ESSENTIAL_TOOLS + ["neovim_edit", "neovim_command"] + UNIX_TOOLS,
        environment={"EDITOR": "vi"}
    ),
    ToolPersonality(
        name="richard",
        programmer="Richard Stallman",
        description="GNU creator - software freedom",
        philosophy="Free software is a matter of liberty, not price.",
        tools=ESSENTIAL_TOOLS + ["content_replace", "batch"] + UNIX_TOOLS,
        environment={"EDITOR": "emacs"}
    ),
    ToolPersonality(
        name="brian",
        programmer="Brian Kernighan",
        description="AWK co-creator & Unix pioneer",
        philosophy="Controlling complexity is the essence of computer programming.",
        tools=ESSENTIAL_TOOLS + ["grep", "content_replace"] + UNIX_TOOLS,
        environment={"AWK": "gawk"}
    ),
    ToolPersonality(
        name="donald",
        programmer="Donald Knuth",
        description="TeX creator - literate programming",
        philosophy="Premature optimization is the root of all evil.",
        tools=ESSENTIAL_TOOLS + ["symbols", "todo", "critic"],
        environment={"TEXMFHOME": "~/texmf"}
    ),
    ToolPersonality(
        name="graydon",
        programmer="Graydon Hoare",
        description="Rust creator - memory safety without GC",
        philosophy="Memory safety without garbage collection, concurrency without data races.",
        tools=ESSENTIAL_TOOLS + ["symbols", "multi_edit", "critic", "todo"] + BUILD_TOOLS,
        environment={"RUST_BACKTRACE": "1", "CARGO_HOME": "~/.cargo"}
    ),
    ToolPersonality(
        name="ryan",
        programmer="Ryan Dahl",
        description="Node.js & Deno creator",
        philosophy="I/O needs to be done differently.",
        tools=ESSENTIAL_TOOLS + ["npx", "uvx", "watch", "process"] + BUILD_TOOLS,
        environment={"DENO_DIR": "~/.deno"}
    ),
    ToolPersonality(
        name="mitchell",
        programmer="Mitchell Hashimoto",
        description="HashiCorp founder - infrastructure as code",
        philosophy="Automate everything.",
        tools=ESSENTIAL_TOOLS + ["bash", "process", "watch", "todo"] + BUILD_TOOLS,
        environment={"TERRAFORM_VERSION": "1.0"}
    ),
    
    # 21-30: Web & Frontend
    ToolPersonality(
        name="tim",
        programmer="Tim Berners-Lee",
        description="WWW inventor - open web",
        philosophy="The Web is for everyone.",
        tools=ESSENTIAL_TOOLS + ["npx", "watch", "rules"] + SEARCH_TOOLS,
        environment={"W3C_VALIDATOR": "true"}
    ),
    ToolPersonality(
        name="douglas",
        programmer="Douglas Crockford",
        description="JSON creator - JavaScript the good parts",
        philosophy="JavaScript has some extraordinarily good parts.",
        tools=ESSENTIAL_TOOLS + ["npx", "symbols", "critic"] + SEARCH_TOOLS,
        environment={"JSLINT": "true"}
    ),
    ToolPersonality(
        name="john",
        programmer="John Resig",
        description="jQuery creator - write less, do more",
        philosophy="Do more with less code.",
        tools=ESSENTIAL_TOOLS + ["npx", "watch", "symbols"] + SEARCH_TOOLS,
        environment={"JQUERY_VERSION": "3.6"}
    ),
    ToolPersonality(
        name="evan",
        programmer="Evan You",
        description="Vue.js creator - progressive framework",
        philosophy="Approachable, versatile, performant.",
        tools=ESSENTIAL_TOOLS + ["npx", "watch", "symbols", "todo"] + BUILD_TOOLS,
        environment={"VUE_VERSION": "3"}
    ),
    ToolPersonality(
        name="jordan",
        programmer="Jordan Walke",
        description="React creator - declarative UIs",
        philosophy="Learn once, write anywhere.",
        tools=ESSENTIAL_TOOLS + ["npx", "watch", "symbols", "rules"] + BUILD_TOOLS,
        environment={"REACT_VERSION": "18"}
    ),
    ToolPersonality(
        name="jeremy",
        programmer="Jeremy Ashkenas",
        description="CoffeeScript & Backbone creator",
        philosophy="It's just JavaScript.",
        tools=ESSENTIAL_TOOLS + ["npx", "symbols", "watch"],
        environment={"COFFEE_VERSION": "2.0"}
    ),
    ToolPersonality(
        name="david",
        programmer="David Heinemeier Hansson",
        description="Rails creator - convention over configuration",
        philosophy="Optimize for programmer happiness.",
        tools=ESSENTIAL_TOOLS + ["npx", "sql_query", "watch", "todo"] + DATABASE_TOOLS,
        environment={"RAILS_ENV": "development"}
    ),
    ToolPersonality(
        name="taylor",
        programmer="Taylor Otwell",
        description="Laravel creator - PHP artisan",
        philosophy="Love beautiful code? We do too.",
        tools=ESSENTIAL_TOOLS + ["npx", "sql_query", "watch"] + DATABASE_TOOLS,
        environment={"LARAVEL_VERSION": "10"}
    ),
    ToolPersonality(
        name="adrian",
        programmer="Adrian Holovaty",
        description="Django co-creator - web framework for perfectionists",
        philosophy="The web framework for perfectionists with deadlines.",
        tools=ESSENTIAL_TOOLS + ["uvx", "sql_query", "watch"] + DATABASE_TOOLS,
        environment={"DJANGO_SETTINGS_MODULE": "settings"}
    ),
    ToolPersonality(
        name="matt",
        programmer="Matt Mullenweg",
        description="WordPress creator - democratize publishing",
        philosophy="Code is poetry.",
        tools=ESSENTIAL_TOOLS + ["sql_query", "watch", "rules"] + DATABASE_TOOLS,
        environment={"WP_DEBUG": "true"}
    ),
    
    # 31-40: Database & Data
    ToolPersonality(
        name="michael_s",
        programmer="Michael Stonebraker",
        description="PostgreSQL creator - ACID matters",
        philosophy="One size does not fit all in databases.",
        tools=ESSENTIAL_TOOLS + DATABASE_TOOLS + ["batch", "todo"],
        environment={"PGDATA": "/var/lib/postgresql/data"}
    ),
    ToolPersonality(
        name="michael_w",
        programmer="Michael Widenius",
        description="MySQL/MariaDB creator",
        philosophy="A small fast database for the web.",
        tools=ESSENTIAL_TOOLS + DATABASE_TOOLS + ["watch"],
        environment={"MYSQL_HOME": "/usr/local/mysql"}
    ),
    ToolPersonality(
        name="salvatore",
        programmer="Salvatore Sanfilippo",
        description="Redis creator - data structures server",
        philosophy="Simplicity is a great virtue.",
        tools=ESSENTIAL_TOOLS + ["bash", "watch", "process"] + DATABASE_TOOLS,
        environment={"REDIS_VERSION": "7.0"}
    ),
    ToolPersonality(
        name="dwight",
        programmer="Dwight Merriman",
        description="MongoDB co-creator - document databases",
        philosophy="Build the database you want to use.",
        tools=ESSENTIAL_TOOLS + DATABASE_TOOLS + ["watch", "todo"],
        environment={"MONGO_VERSION": "6.0"}
    ),
    ToolPersonality(
        name="edgar",
        programmer="Edgar F. Codd",
        description="Relational model inventor",
        philosophy="Data independence is key.",
        tools=ESSENTIAL_TOOLS + DATABASE_TOOLS + ["critic"],
        environment={"SQL_MODE": "ANSI"}
    ),
    ToolPersonality(
        name="jim_gray",
        programmer="Jim Gray",
        description="Transaction processing pioneer",
        philosophy="The transaction is the unit of work.",
        tools=ESSENTIAL_TOOLS + DATABASE_TOOLS + ["batch", "critic"],
        environment={"ISOLATION_LEVEL": "SERIALIZABLE"}
    ),
    ToolPersonality(
        name="jeff_dean",
        programmer="Jeff Dean",
        description="MapReduce & BigTable co-creator",
        philosophy="Design for planet-scale.",
        tools=ESSENTIAL_TOOLS + DATABASE_TOOLS + VECTOR_TOOLS + ["batch"],
        environment={"HADOOP_HOME": "/opt/hadoop"}
    ),
    ToolPersonality(
        name="sanjay",
        programmer="Sanjay Ghemawat",
        description="MapReduce & BigTable co-creator",
        philosophy="Simple abstractions for complex systems.",
        tools=ESSENTIAL_TOOLS + DATABASE_TOOLS + ["batch", "process"],
        environment={"SPARK_HOME": "/opt/spark"}
    ),
    ToolPersonality(
        name="mike",
        programmer="Mike Cafarella",
        description="Hadoop co-creator",
        philosophy="Storage is cheap, compute is cheap.",
        tools=ESSENTIAL_TOOLS + DATABASE_TOOLS + ["batch", "process"],
        environment={"HADOOP_CONF_DIR": "/etc/hadoop"}
    ),
    ToolPersonality(
        name="matei",
        programmer="Matei Zaharia",
        description="Apache Spark creator",
        philosophy="In-memory computing changes everything.",
        tools=ESSENTIAL_TOOLS + DATABASE_TOOLS + ["batch", "process", "jupyter"],
        environment={"SPARK_MASTER": "local[*]"}
    ),
    
    # 41-50: AI & Machine Learning
    ToolPersonality(
        name="yann",
        programmer="Yann LeCun",
        description="Deep learning pioneer - ConvNets",
        philosophy="AI is not magic; it's just math and data.",
        tools=ESSENTIAL_TOOLS + AI_TOOLS + VECTOR_TOOLS + ["jupyter", "watch"],
        environment={"PYTORCH_VERSION": "2.0"}
    ),
    ToolPersonality(
        name="geoffrey",
        programmer="Geoffrey Hinton",
        description="Deep learning godfather",
        philosophy="The brain has to work with what it's got.",
        tools=ESSENTIAL_TOOLS + AI_TOOLS + VECTOR_TOOLS + ["jupyter"],
        environment={"TF_VERSION": "2.13"}
    ),
    ToolPersonality(
        name="yoshua",
        programmer="Yoshua Bengio",
        description="Deep learning pioneer",
        philosophy="We need to think about AI that helps humanity.",
        tools=ESSENTIAL_TOOLS + AI_TOOLS + VECTOR_TOOLS + ["jupyter", "batch"],
        environment={"THEANO_FLAGS": "device=cuda"}
    ),
    ToolPersonality(
        name="andrew",
        programmer="Andrew Ng",
        description="AI educator & Coursera co-founder",
        philosophy="AI is the new electricity.",
        tools=ESSENTIAL_TOOLS + AI_TOOLS + ["jupyter", "todo", "watch"],
        environment={"CUDA_VISIBLE_DEVICES": "0"}
    ),
    ToolPersonality(
        name="demis",
        programmer="Demis Hassabis",
        description="DeepMind co-founder",
        philosophy="Solve intelligence, use it to solve everything else.",
        tools=ESSENTIAL_TOOLS + AI_TOOLS + VECTOR_TOOLS + ["agent", "consensus"],
        environment={"JAX_VERSION": "0.4"}
    ),
    ToolPersonality(
        name="ilya",
        programmer="Ilya Sutskever",
        description="OpenAI co-founder",
        philosophy="Scale is all you need.",
        tools=ESSENTIAL_TOOLS + AI_TOOLS + ["agent", "consensus", "critic"],
        environment={"OPENAI_API_KEY": "sk-..."}
    ),
    ToolPersonality(
        name="andrej",
        programmer="Andrej Karpathy",
        description="AI educator & Tesla AI director",
        philosophy="Build it from scratch to understand it.",
        tools=ESSENTIAL_TOOLS + AI_TOOLS + ["jupyter", "watch", "todo"],
        environment={"CUDA_HOME": "/usr/local/cuda"}
    ),
    ToolPersonality(
        name="chris",
        programmer="Chris Olah",
        description="AI interpretability researcher",
        philosophy="Understanding neural networks matters.",
        tools=ESSENTIAL_TOOLS + AI_TOOLS + VECTOR_TOOLS + ["jupyter", "critic"],
        environment={"DISTILL_MODE": "interactive"}
    ),
    ToolPersonality(
        name="francois",
        programmer="François Chollet",
        description="Keras creator",
        philosophy="Deep learning for humans.",
        tools=ESSENTIAL_TOOLS + AI_TOOLS + ["jupyter", "watch", "todo"],
        environment={"KERAS_BACKEND": "tensorflow"}
    ),
    ToolPersonality(
        name="jeremy_howard",
        programmer="Jeremy Howard",
        description="fast.ai founder",
        philosophy="Deep learning should be accessible to all.",
        tools=ESSENTIAL_TOOLS + AI_TOOLS + ["jupyter", "watch", "rules"],
        environment={"FASTAI_VERSION": "2.7"}
    ),
    
    # 51-60: Security & Cryptography
    ToolPersonality(
        name="bruce",
        programmer="Bruce Schneier",
        description="Security expert & cryptographer",
        philosophy="Security is a process, not a product.",
        tools=ESSENTIAL_TOOLS + ["critic", "symbols", "git_search"] + UNIX_TOOLS,
        environment={"SECURITY_AUDIT": "true"}
    ),
    ToolPersonality(
        name="phil",
        programmer="Phil Zimmermann",
        description="PGP creator - privacy matters",
        philosophy="If privacy is outlawed, only outlaws will have privacy.",
        tools=ESSENTIAL_TOOLS + ["critic", "content_replace"] + UNIX_TOOLS,
        environment={"GPG_TTY": "$(tty)"}
    ),
    ToolPersonality(
        name="whitfield",
        programmer="Whitfield Diffie",
        description="Public-key cryptography pioneer",
        philosophy="Privacy is necessary for an open society.",
        tools=ESSENTIAL_TOOLS + ["critic", "symbols"],
        environment={"OPENSSL_VERSION": "3.0"}
    ),
    ToolPersonality(
        name="ralph",
        programmer="Ralph Merkle",
        description="Merkle trees inventor",
        philosophy="Cryptography is about mathematical guarantees.",
        tools=ESSENTIAL_TOOLS + ["symbols", "critic", "batch"],
        environment={"HASH_ALGORITHM": "SHA256"}
    ),
    ToolPersonality(
        name="daniel_b",
        programmer="Daniel J. Bernstein",
        description="djb - qmail & Curve25519 creator",
        philosophy="Security through simplicity.",
        tools=ESSENTIAL_TOOLS + ["critic", "symbols"] + UNIX_TOOLS,
        environment={"QMAIL_HOME": "/var/qmail"}
    ),
    ToolPersonality(
        name="moxie",
        programmer="Moxie Marlinspike",
        description="Signal creator - privacy for everyone",
        philosophy="Making private communication simple.",
        tools=ESSENTIAL_TOOLS + ["critic", "symbols", "rules"],
        environment={"SIGNAL_PROTOCOL": "true"}
    ),
    ToolPersonality(
        name="theo",
        programmer="Theo de Raadt",
        description="OpenBSD creator - security by default",
        philosophy="Shut up and hack.",
        tools=ESSENTIAL_TOOLS + ["critic", "diff"] + UNIX_TOOLS,
        environment={"OPENBSD_VERSION": "7.3"}
    ),
    ToolPersonality(
        name="dan_kaminsky",
        programmer="Dan Kaminsky",
        description="DNS security researcher",
        philosophy="Break it to make it better.",
        tools=ESSENTIAL_TOOLS + ["critic", "symbols", "process"] + UNIX_TOOLS,
        environment={"DNSSEC": "true"}
    ),
    ToolPersonality(
        name="katie",
        programmer="Katie Moussouris",
        description="Bug bounty pioneer",
        philosophy="Hackers are a resource, not a threat.",
        tools=ESSENTIAL_TOOLS + ["critic", "symbols", "todo"],
        environment={"BUG_BOUNTY": "enabled"}
    ),
    ToolPersonality(
        name="matt_blaze",
        programmer="Matt Blaze",
        description="Cryptographer & security researcher",
        philosophy="Crypto is hard to get right.",
        tools=ESSENTIAL_TOOLS + ["critic", "symbols", "git_search"],
        environment={"CRYPTO_LIBRARY": "nacl"}
    ),
    
    # 61-70: Gaming & Graphics
    ToolPersonality(
        name="john_carmack",
        programmer="John Carmack",
        description="id Software - Doom & Quake creator",
        philosophy="Focus is a matter of deciding what things you're not going to do.",
        tools=ESSENTIAL_TOOLS + ["symbols", "watch", "process"] + BUILD_TOOLS,
        environment={"OPENGL_VERSION": "4.6"}
    ),
    ToolPersonality(
        name="sid",
        programmer="Sid Meier",
        description="Civilization creator",
        philosophy="A game is a series of interesting choices.",
        tools=ESSENTIAL_TOOLS + ["todo", "watch", "process"],
        environment={"GAME_MODE": "debug"}
    ),
    ToolPersonality(
        name="shigeru",
        programmer="Shigeru Miyamoto",
        description="Mario & Zelda creator",
        philosophy="A delayed game is eventually good, but a rushed game is forever bad.",
        tools=ESSENTIAL_TOOLS + ["todo", "watch", "critic"],
        environment={"NINTENDO_SDK": "true"}
    ),
    ToolPersonality(
        name="gabe",
        programmer="Gabe Newell",
        description="Valve founder - Half-Life & Steam",
        philosophy="The easiest way to stop piracy is not by putting antipiracy technology to work. It's by giving those people a service that's better than what they're receiving from the pirates.",
        tools=ESSENTIAL_TOOLS + ["process", "watch", "todo"] + BUILD_TOOLS,
        environment={"STEAM_RUNTIME": "1"}
    ),
    ToolPersonality(
        name="markus",
        programmer="Markus Persson",
        description="Minecraft creator - Notch",
        philosophy="Just make games for yourself and try to have fun.",
        tools=ESSENTIAL_TOOLS + ["watch", "todo", "process"],
        environment={"LWJGL_VERSION": "3.3"}
    ),
    ToolPersonality(
        name="jonathan",
        programmer="Jonathan Blow",
        description="Braid & The Witness creator",
        philosophy="Optimize for deep, meaningful experiences.",
        tools=ESSENTIAL_TOOLS + ["symbols", "critic", "watch"],
        environment={"JAI_COMPILER": "beta"}
    ),
    ToolPersonality(
        name="casey",
        programmer="Casey Muratori",
        description="Handmade Hero creator",
        philosophy="Performance matters. Write code from scratch.",
        tools=ESSENTIAL_TOOLS + ["symbols", "watch", "process", "critic"],
        environment={"HANDMADE": "true"}
    ),
    ToolPersonality(
        name="tim_sweeney",
        programmer="Tim Sweeney",
        description="Epic Games founder - Unreal Engine",
        philosophy="The engine is the game.",
        tools=ESSENTIAL_TOOLS + ["symbols", "watch", "process"] + BUILD_TOOLS,
        environment={"UNREAL_ENGINE": "5"}
    ),
    ToolPersonality(
        name="hideo",
        programmer="Hideo Kojima",
        description="Metal Gear creator",
        philosophy="70% of my body is made of movies.",
        tools=ESSENTIAL_TOOLS + ["todo", "watch", "critic"],
        environment={"KOJIMA_PRODUCTIONS": "true"}
    ),
    ToolPersonality(
        name="will",
        programmer="Will Wright",
        description="SimCity & The Sims creator",
        philosophy="Games are a form of communication.",
        tools=ESSENTIAL_TOOLS + ["todo", "watch", "process"],
        environment={"SIMULATION_MODE": "debug"}
    ),
    
    # 71-80: Open Source Leaders
    ToolPersonality(
        name="miguel",
        programmer="Miguel de Icaza",
        description="GNOME & Mono creator",
        philosophy="Open source is about standing on the shoulders of giants.",
        tools=ESSENTIAL_TOOLS + ["symbols", "todo"] + BUILD_TOOLS,
        environment={"MONO_VERSION": "6.12"}
    ),
    ToolPersonality(
        name="nat",
        programmer="Nat Friedman",
        description="GitHub CEO & AI entrepreneur",
        philosophy="Developers are the builders of the digital world.",
        tools=ESSENTIAL_TOOLS + AI_TOOLS + ["git_search", "todo"],
        environment={"GITHUB_TOKEN": "ghp_..."}
    ),
    ToolPersonality(
        name="patrick",
        programmer="Patrick Volkerding",
        description="Slackware creator",
        philosophy="Keep it simple, keep it stable.",
        tools=ESSENTIAL_TOOLS + UNIX_TOOLS,
        environment={"SLACKWARE_VERSION": "15.0"}
    ),
    ToolPersonality(
        name="ian",
        programmer="Ian Murdock",
        description="Debian founder",
        philosophy="Free software, free society.",
        tools=ESSENTIAL_TOOLS + UNIX_TOOLS + ["todo"],
        environment={"DEBIAN_FRONTEND": "noninteractive"}
    ),
    ToolPersonality(
        name="mark_shuttleworth",
        programmer="Mark Shuttleworth",
        description="Ubuntu founder",
        philosophy="Linux for human beings.",
        tools=ESSENTIAL_TOOLS + ["todo", "rules"] + BUILD_TOOLS,
        environment={"UBUNTU_VERSION": "22.04"}
    ),
    ToolPersonality(
        name="lennart",
        programmer="Lennart Poettering",
        description="systemd creator",
        philosophy="Do one thing and do it well... or do everything.",
        tools=ESSENTIAL_TOOLS + ["process", "watch"] + UNIX_TOOLS,
        environment={"SYSTEMD_VERSION": "253"}
    ),
    ToolPersonality(
        name="bram",
        programmer="Bram Moolenaar",
        description="Vim creator",
        philosophy="The best way to avoid RSI is to not type so much.",
        tools=ESSENTIAL_TOOLS + ["neovim_edit", "neovim_command", "neovim_session"],
        environment={"VIM_VERSION": "9.0"}
    ),
    ToolPersonality(
        name="daniel_r",
        programmer="Daniel Robbins",
        description="Gentoo founder",
        philosophy="Your system, your way.",
        tools=ESSENTIAL_TOOLS + BUILD_TOOLS + UNIX_TOOLS,
        environment={"GENTOO_PROFILE": "default/linux/amd64/17.1"}
    ),
    ToolPersonality(
        name="judd",
        programmer="Judd Vinet",
        description="Arch Linux creator",
        philosophy="Keep it simple.",
        tools=ESSENTIAL_TOOLS + BUILD_TOOLS + UNIX_TOOLS,
        environment={"ARCH_VERSION": "rolling"}
    ),
    ToolPersonality(
        name="fabrice",
        programmer="Fabrice Bellard",
        description="QEMU & FFmpeg creator",
        philosophy="Small, fast, and elegant code.",
        tools=ESSENTIAL_TOOLS + ["symbols", "process"] + BUILD_TOOLS,
        environment={"QEMU_VERSION": "8.0"}
    ),
    
    # 81-90: Modern Innovators
    ToolPersonality(
        name="vitalik",
        programmer="Vitalik Buterin",
        description="Ethereum creator",
        philosophy="Decentralization matters.",
        tools=ESSENTIAL_TOOLS + ["symbols", "critic", "todo"] + AI_TOOLS,
        environment={"ETH_NETWORK": "mainnet"}
    ),
    ToolPersonality(
        name="satoshi",
        programmer="Satoshi Nakamoto",
        description="Bitcoin creator",
        philosophy="Trust in mathematics.",
        tools=ESSENTIAL_TOOLS + ["critic", "symbols"] + UNIX_TOOLS,
        environment={"BITCOIN_NETWORK": "mainnet"}
    ),
    ToolPersonality(
        name="chris_lattner",
        programmer="Chris Lattner",
        description="LLVM & Swift creator",
        philosophy="Compiler infrastructure should be modular.",
        tools=ESSENTIAL_TOOLS + ["symbols", "multi_edit", "critic"] + BUILD_TOOLS,
        environment={"LLVM_VERSION": "16"}
    ),
    ToolPersonality(
        name="joe",
        programmer="Joe Armstrong",
        description="Erlang creator",
        philosophy="Let it crash.",
        tools=ESSENTIAL_TOOLS + ["process", "watch", "critic"],
        environment={"ERL_VERSION": "OTP-26"}
    ),
    ToolPersonality(
        name="jose",
        programmer="José Valim",
        description="Elixir creator",
        philosophy="Productive. Reliable. Fast.",
        tools=ESSENTIAL_TOOLS + ["watch", "process", "todo"],
        environment={"ELIXIR_VERSION": "1.15"}
    ),
    ToolPersonality(
        name="sebastian",
        programmer="Sebastian Thrun",
        description="Udacity founder & self-driving car pioneer",
        philosophy="Education should be accessible to all.",
        tools=ESSENTIAL_TOOLS + AI_TOOLS + ["jupyter", "watch"],
        environment={"ROS_VERSION": "noetic"}
    ),
    ToolPersonality(
        name="palmer",
        programmer="Palmer Luckey",
        description="Oculus founder",
        philosophy="VR is the final medium.",
        tools=ESSENTIAL_TOOLS + ["watch", "process"] + BUILD_TOOLS,
        environment={"UNITY_VERSION": "2023.1"}
    ),
    ToolPersonality(
        name="dylan",
        programmer="Dylan Field",
        description="Figma co-founder",
        philosophy="Design tools should be collaborative.",
        tools=ESSENTIAL_TOOLS + ["watch", "todo", "rules"],
        environment={"FIGMA_API": "enabled"}
    ),
    ToolPersonality(
        name="guillermo",
        programmer="Guillermo Rauch",
        description="Vercel founder & Next.js creator",
        philosophy="Make the Web. Faster.",
        tools=ESSENTIAL_TOOLS + ["npx", "watch", "rules"] + BUILD_TOOLS,
        environment={"NEXT_VERSION": "14"}
    ),
    ToolPersonality(
        name="tom",
        programmer="Tom Preston-Werner",
        description="GitHub co-founder & TOML creator",
        philosophy="Optimize for happiness.",
        tools=ESSENTIAL_TOOLS + ["git_search", "todo", "rules"],
        environment={"GITHUB_ACTIONS": "true"}
    ),
    
    # 91-100: Special Configurations
    ToolPersonality(
        name="fullstack",
        programmer="Full Stack Developer",
        description="Every tool for every job",
        philosophy="Jack of all trades, master of... well, all trades.",
        tools=list(set(ESSENTIAL_TOOLS + AI_TOOLS + SEARCH_TOOLS + DATABASE_TOOLS + 
                       BUILD_TOOLS + UNIX_TOOLS + VECTOR_TOOLS + ["todo", "rules", "watch", 
                       "jupyter", "neovim_edit", "mcp", "consensus"])),
        environment={"ALL_TOOLS": "enabled"}
    ),
    ToolPersonality(
        name="minimal",
        programmer="Minimalist",
        description="Just the essentials",
        philosophy="Less is more.",
        tools=ESSENTIAL_TOOLS,
        environment={"MINIMAL_MODE": "true"}
    ),
    ToolPersonality(
        name="data_scientist",
        programmer="Data Scientist",
        description="Analyze all the things",
        philosophy="In God we trust. All others must bring data.",
        tools=ESSENTIAL_TOOLS + ["jupyter", "sql_query", "stats"] + VECTOR_TOOLS + AI_TOOLS,
        environment={"JUPYTER_THEME": "dark"}
    ),
    ToolPersonality(
        name="devops",
        programmer="DevOps Engineer",
        description="Automate everything",
        philosophy="You build it, you run it.",
        tools=ESSENTIAL_TOOLS + BUILD_TOOLS + ["process", "watch", "todo"] + UNIX_TOOLS,
        environment={"CI_CD": "enabled"}
    ),
    ToolPersonality(
        name="security",
        programmer="Security Researcher",
        description="Break it to secure it",
        philosophy="The only secure system is one that's powered off.",
        tools=ESSENTIAL_TOOLS + ["critic", "symbols", "git_search"] + UNIX_TOOLS,
        environment={"SECURITY_MODE": "paranoid"}
    ),
    ToolPersonality(
        name="academic",
        programmer="Academic Researcher",
        description="Publish or perish",
        philosophy="Standing on the shoulders of giants.",
        tools=ESSENTIAL_TOOLS + ["jupyter", "todo", "critic"] + AI_TOOLS + SEARCH_TOOLS,
        environment={"LATEX_ENGINE": "xelatex"}
    ),
    ToolPersonality(
        name="startup",
        programmer="Startup Founder",
        description="Move fast and fix things",
        philosophy="Done is better than perfect.",
        tools=ESSENTIAL_TOOLS + ["todo", "agent", "consensus"] + BUILD_TOOLS + DATABASE_TOOLS,
        environment={"STARTUP_MODE": "hustle"}
    ),
    ToolPersonality(
        name="enterprise",
        programmer="Enterprise Developer",
        description="Process and compliance",
        philosophy="Nobody ever got fired for buying IBM.",
        tools=ESSENTIAL_TOOLS + ["todo", "critic", "rules", "stats"] + DATABASE_TOOLS,
        environment={"COMPLIANCE": "SOC2"}
    ),
    ToolPersonality(
        name="creative",
        programmer="Creative Coder",
        description="Code as art",
        philosophy="Programming is the art of the possible.",
        tools=ESSENTIAL_TOOLS + ["watch", "jupyter", "todo"] + AI_TOOLS,
        environment={"P5_MODE": "global"}
    ),
    ToolPersonality(
        name="hanzo",
        programmer="Hanzo AI Default",
        description="Balanced productivity and quality",
        philosophy="The Zen of Model Context Protocol.",
        tools=ESSENTIAL_TOOLS + ["agent", "consensus", "critic", "todo", "rules", "symbols", 
                "search", "git_search", "watch", "jupyter"] + BUILD_TOOLS,
        environment={"HANZO_MODE": "zen"}
    )
]

# Register all personalities
def register_default_personalities():
    """Register all default tool personalities."""
    for personality in personalities:
        PersonalityRegistry.register(personality)


# Ensure agent tool is enabled when API keys are present
def ensure_agent_enabled(personality: ToolPersonality) -> ToolPersonality:
    """Ensure agent tool is enabled if API keys are present."""
    api_keys_present = any(
        os.environ.get(key) for key in [
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY", 
            "GOOGLE_API_KEY",
            "HANZO_API_KEY",
            "GROQ_API_KEY",
            "TOGETHER_API_KEY",
            "MISTRAL_API_KEY",
            "PERPLEXITY_API_KEY"
        ]
    )
    
    if api_keys_present and "agent" not in personality.tools:
        personality.tools.append("agent")
        if "consensus" not in personality.tools:
            personality.tools.append("consensus")
    
    return personality
