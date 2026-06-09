# Ask User Selection Specification

## Requirements

### Requirement: Single Source of Truth for Selection Row Ordering

The `ask_user` selection list SHALL derive the order, count, and kind of every
visible row from one shared model in the layout module. The canonical order is
`option*`, followed by the comment-toggle row when comments are allowed, followed
by the freeform row when freeform input is allowed. All list components and the
row renderer SHALL classify indices through this model rather than computing the
ordering independently.

#### Scenario: Comment-toggle and freeform appended after options

- WHEN a selection list has N options with both the comment-toggle and freeform rows enabled
- THEN the shared model reports a row count of N+2
- AND it reports the comment-toggle at index N and the freeform row at index N+1

#### Scenario: Freeform only, no comment

- WHEN a selection list has N options with freeform enabled and comments disabled
- THEN the shared model reports a row count of N+1
- AND it classifies index N as the freeform row and reports no comment-toggle index

#### Scenario: No synthetic rows

- WHEN a selection list has N options with both comments and freeform disabled
- THEN the shared model reports a row count of N
- AND every index in range is classified as an option row

#### Scenario: Classification drives row identity

- WHEN a list component needs to know whether a given index is the comment-toggle or freeform row
- THEN the answer comes from the shared model
- AND the component holds no independent comment/freeform index arithmetic

### Requirement: Row Model Parameterized by Visible Option Count

The shared selection row model SHALL accept the count of currently-visible
options as input, so that a full-list component and a filtered (searched)
component share identical ordering and classification logic while differing only
in which option count they supply.

#### Scenario: Full-list component supplies the raw count

- WHEN the multi-select list builds its row model
- THEN it supplies the total (unfiltered) option count
- AND the resulting indices range over the unfiltered list

#### Scenario: Filtered viewport supplies the filtered count

- WHEN the single-select list builds its row model after applying a fuzzy-search filter
- THEN it supplies the count of options that survived the filter
- AND the comment-toggle and freeform indices fall immediately after the filtered options

#### Scenario: Out-of-range index

- WHEN the model is asked to classify an index that is negative or not less than the row count
- THEN it returns no classification

### Requirement: Behavior-Preserving Consolidation

Consolidating the selection row model SHALL NOT change any user-visible behavior
of the `ask_user` tool. Row order, row counts, keyboard navigation, the
comment-toggle, and freeform routing remain identical to the pre-consolidation
behavior.

#### Scenario: Existing interaction tests pass unchanged

- WHEN the consolidation is implemented
- THEN the existing ask_user interaction tests pass without any change to their assertions

#### Scenario: Renderer and components agree

- WHEN the row renderer and a list component are given the same visible options and flags
- THEN the row the renderer marks at a given index and the kind the component classifies at that index refer to the same item

