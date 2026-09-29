# *Design It!* — Harness application notes

**Source:** Michael Keeling, *Design It!: From Programmer to Software Architect*. Page references are the printed page numbers in the supplied edition. These notes are paraphrases and application guidance, not a replacement for the source.

## Principles relevant to software project guidance

### Design as an iterative learning loop

Chapter 2, “Design Thinking Fundamentals,” presents design as a repeated **Think, Do, Check** cycle (p. 21): identify what must be learned and the important risks; make something tangible quickly; inspect what was learned and choose the next move. Design continues as understanding changes.

**Harness application:** intake and architecture are not one giant up-front specification. Ask enough to choose the next safe step, make a concrete proposal or prototype where useful, inspect evidence, and revise with the owner. Preserve decisions and assumptions so later agents can see what changed.

### Let risk guide the amount and order of design

Chapter 3, “Devise a Design Strategy,” says to let risk guide design effort (pp. 27–36). A risk can be recorded as a current condition and a possible adverse consequence; prioritize by likelihood and impact, then choose an activity that reduces uncertainty.

**Harness application:** do not conduct broad research or create a detailed architecture for every uncertainty. Identify which unknown could materially change the MVP, architecture, safety, cost, or first authorized WU. Research, prototype, model, or ask the owner only to the extent needed to reduce that risk.

### Make stakeholders, constraints, and quality attributes explicit

Chapter 5, “Discover Architecture Significant Requirements,” distinguishes functional needs, constraints, and quality attributes (pp. 49–60). Chapter 14 provides problem-discovery activities (pp. 191–221), including interviews, assumptions, and quality scenarios.

**Harness application:** intake should adaptively ask who the users are, what outcome they need, which constraints matter, and how success or a quality target can be observed. For relevant non-functional needs, turn vague terms such as “fast,” “secure,” or “reliable” into a scenario with a stimulus, context, expected response, and measurable response level.

### Explore architecture options and explain the whole design

Chapter 6, “Choose an Architecture,” covers constraints, quality attributes, responsibilities, and design for change (pp. 63–81). Chapter 11, “Describe an Architecture,” explicitly discusses telling the whole story (p. 143), stakeholder-centered views, and decision rationale (pp. 152–155). Chapter 16 includes architecture decision records, context diagrams, modular decomposition, and prototypes (pp. 259–281).

**Harness application:** compare only plausible options against the actual constraints and important quality scenarios. Record the decision, alternatives, consequences, and evidence in an ADR when the choice is consequential or hard to reverse. Keep architecture descriptions understandable to their intended stakeholders.

### Evaluate decisions continuously

Chapter 12, “Evaluate an Architecture,” encourages continuous evaluation (pp. 159–177); Chapter 17 describes evaluating options, risk storming, and scenario walkthroughs (pp. 285–312).

**Harness application:** evaluate a proposed design against realistic scenarios and acceptance evidence before making it authority. During Epic closure, compare the delivered behavior with the promised user-visible outcome. A review or evaluation finding informs a decision; it does not automatically authorize extra work.

## Story connection: theory and project evidence

Chapter 11's “Tell the Whole Story” (p. 143) concerns communicating an architecture so stakeholders can understand how its parts and decisions fit together. Chapter 17's scenario walkthroughs also use a narrative scenario to examine design choices.

The Harness's stronger rule—**one continuing project story, finite Epics as chapters, and indivisible WUs as connected story beats**—is an explicit governance design derived from the Alfran and LLM Learning comparison and owner direction. *Design It!* supports making rationale and the whole design legible; it does not establish the specific Epic/WU hierarchy or prove that this delivery structure works. Keep those evidence sources distinct.

## Relevant source map

- Chapter 2: design mindset; Think/Do/Check (p. 21).
- Chapter 3: design strategy and risk (pp. 27–36).
- Chapter 5: constraints and architecture-significant requirements (pp. 49–60).
- Chapter 6: architecture choices and design for change (pp. 63–81).
- Chapter 11: architecture description, whole story, and rationale (pp. 143–157).
- Chapter 12: continuous architecture evaluation (pp. 159–177).
- Chapter 14: problem-discovery activities and quality scenarios (pp. 191–221).
- Chapter 16: ADRs, context diagrams, decomposition, and prototypes (pp. 259–281).
- Chapter 17: option evaluation and scenario walkthroughs (pp. 285–312).
