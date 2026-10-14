//! Kai Actions.
//!
//! An *action* is one saved, typed, verified operation: its inputs and what each may be, the
//! preconditions that must hold, what it does to the world (which decides whether the user must
//! approve it), what its result depends on, and the check that its effect happened. A *workflow*
//! is a plan of several actions. The *cache* holds what an action has been seen to do (a proof,
//! keyed by its version and tools) and the results it can reuse (keyed by what they read).
//!
//! Dev asks this crate in four steps, each exposed:
//!
//! 1. match: [`bind::triggered`] gives the actions and workflows whose triggers fit a request;
//! 2. bind: [`bind::plan`] binds their inputs from the request and from values read out of the
//!    repository, asking Kai (a [`Chooser`]) only when several actions or values remain;
//! 3. run: [`run::perform`] checks preconditions again just before each step, authorizes,
//!    consults the cache and runs;
//! 4. verify: each step's own verifier decides, and every step leaves a [`ledger::Record`].
//!
//! Kai never writes a command. It chooses among actions and among values read from the repository;
//! a request nothing fits, or that stays ambiguous, is declined and goes to the normal agent.

pub mod action;
pub mod ask;
pub mod bind;
pub mod cache;
pub mod catalog;
pub mod cli;
pub mod exec;
pub mod ledger;
pub mod redact;
pub mod run;
pub mod state;
pub mod text;
pub mod workflow;

pub use action::{Action, Args, Effect};
pub use ask::{Chooser, Kai};
pub use bind::{Config, Decline, plan, triggered};
pub use cache::Store;
pub use ledger::{Outcome, Record};
pub use run::{Approver, Engine, Report, perform};

#[cfg(test)]
mod tests;
