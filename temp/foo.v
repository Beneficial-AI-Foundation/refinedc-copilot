From Coq Require Import Lia.
Lemma foo : forall n m, n + m = m + n.
Proof. intros n m.
