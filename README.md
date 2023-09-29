# ark-liquid-poc

This is a proof of concept for [Ark](https://www.arkpill.me/) running on the Liquid Network. It may differs from the final implementation and is not intended to be used in production.

## vUtxo covenant

In order to build the vUtxo taproot tree, you need the ASP public key `S`, the vUtxo public key `P` and the vUtxo value `val`.

1. Compute the redeem taproot tree
```
   . redeem root (R0)
   ├── claim: "15 days" OP_CSV P OP_CHECKSIG
   └── forfeit: P+S OP_CHECKSIGFROMSTACKVERIFY OP_0 OP_INSPECTINPUTTXHASH OP_EQUAL
```

* `claim` lets the owner to spend the coin after 15 days.
* `forfeit` checks signature of a message built from input tx id #0. It ensures that the ASP has to provide an input with a given txID while signing a forfeit transaction.

2. Compute the vUtxo base taproot tree

```
   . vUtxo root (R1)
   ├── claim: "30 days" OP_CSV S OP_CHECKSIG
   └── toRedeem: S OP_CHECKSIG OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY R0 OP_EQUAL OP_0 OP_INSPECTOUTPUTVALUE val OP_EQUAL
```
* `claim` lets the ASP to spend the coin after 30 days.
* `toRedeem` forces the owner to move the coin **only** to a redeem taproot tree built with their public key (`R0`).

