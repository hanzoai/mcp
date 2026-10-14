//! Workflows: a plan of several actions, each step an action with its own inputs, a later step
//! able to take a value from an earlier one and to run only if an earlier result allows it.

/// A step runs only when a field of an earlier step's output equals a number.
#[derive(Debug, Clone, Copy)]
pub struct Guard {
    /// Zero-based index of the earlier step.
    pub step: usize,
    pub field: &'static str,
    pub equals: i64,
}

#[derive(Debug)]
pub struct Part {
    pub action: &'static str,
    /// `(input, "$n.field")`: the input takes `field` of step n's output (n counts from 1).
    pub inherit: &'static [(&'static str, &'static str)],
    pub when: Option<Guard>,
}

#[derive(Debug)]
pub struct Workflow {
    pub id: &'static str,
    pub version: u32,
    pub summary: &'static str,
    pub triggers: &'static [&'static str],
    pub parts: &'static [Part],
}

/// Create a worktree, then run the suite inside it.
pub static ISOLATE: Workflow = Workflow {
    id: "isolate",
    version: 1,
    summary: "Create a git worktree on a new branch, then run the test suite inside that worktree and report the counts.",
    triggers: &[
        r"worktree.*\b(tests?|suite)\b",
        r"\b(tests?|suite)\b.*worktree",
    ],
    parts: &[
        Part {
            action: "worktree",
            inherit: &[],
            when: None,
        },
        Part {
            action: "suite",
            inherit: &[("root", "$1.path")],
            when: None,
        },
    ],
};

/// Run the suite; if nothing failed, commit the named files and push.
pub static SHIP: Workflow = Workflow {
    id: "ship",
    version: 1,
    summary: "Run the test suite and, only if every test passes, commit the named files with a message and push the branch.",
    triggers: &[
        r"\b(tests?|suite)\b.*\b(commit|push)\b",
        r"\b(commit|push)\b.*\b(tests?|suite)\b",
    ],
    parts: &[
        Part {
            action: "suite",
            inherit: &[],
            when: None,
        },
        Part {
            action: "publish",
            inherit: &[],
            when: Some(Guard {
                step: 0,
                field: "failed",
                equals: 0,
            }),
        },
    ],
};

static ALL: [&Workflow; 2] = [&ISOLATE, &SHIP];

pub fn all() -> &'static [&'static Workflow] {
    &ALL
}

pub fn get(id: &str) -> Option<&'static Workflow> {
    all().iter().copied().find(|w| w.id == id)
}
