package db

// Advisory lock keys. Each serializes one kind of write; keeping them in one
// place keeps them distinct.
const (
	// LockMigrations is held (session-level) while migrating.
	LockMigrations = 7_150_001
	// LockEnrollment serializes enrollments so device letters are unique.
	LockEnrollment = 7_150_002
	// LockMenu serializes menu saves so version numbers are unique.
	LockMenu = 7_150_003
	// LockLedger serializes ledger writes and close-outs: seq follows commit
	// order (docs/decisions/0012), and a document is either in a day's
	// close-out snapshot or flagged as arriving after it.
	LockLedger = 7_150_004
)
