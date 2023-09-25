# ark-liquid-poc

This is a proof of concept for [Ark](https://www.arkpill.me/) running on the Liquid Network. It may differs from the final implementation and is not intended to be used in production.

## Overview

The Ark Service Provider creates *pool transactions* thanks to `createPoolTransaction`.

To create a pool transaction, the service provider has to collect two types of objects from the user:
* `SendOrder` -> send virtual utxo to a main-chain script.
* `OnboardOrder` -> create a new virtual utxo from main chain funds.

Pool transaction is a coinjoin transaction broadcasted on the main chain. Onboard orders inputs are signed by users, and send orders inputs are signed by the service provider and the user.

## Onboarding

### Participate to the pool transaction

To get your virtual utxo, you must lock some funds on a special covenant. 

```ts
export type OnboardOrder = {
  coins: UpdaterInput[]; // coins to "lock" on the covenant
  redeemPublicKey: Buffer; // user public key
};
```

The ASP will process the `OnboardOrder` by adding the coins as inputs of the pool transaction and locking the sum of the coins (minus some chain fees) on a covenant output.

The covenant output is a taproot script with 2 leaves:

```
                 Taproot *   
                        / \ 
                redeem *   |
                           |
                  covenant *
```

* redeem lets the user to exit the covenant and get his funds back. It is a 2-of-2 multisig between the user and the ASP.
* covenant leaf also expects 2 signatures from the ASP and the user. But this time it signs a special message containing data about how to spend the output (who and how much). The script rebuilt the message thanks to introspection opcodes and check signatures using `OP_CHECKSIGFROMSTACK`.

### Redeem transaction

While onboarding, user will also receive a *redeem transaction* signed by the ASP. 

This transaction spends the pool transaction output **using the redeem leaf**  to a timelocked script owned by the user only. 

This is the proof that the ASP will not block the user funds: at any time the user can sign the redeem leaf and broadcast the transaction. 

Note that, while receiving the redeem transaction, the user has not broadcasted the pool transaction yet. The redeem tx must be verified by the user before signing the pool transaction.

### Signing the pool transaction

Once the ASP has finished the pool transaction (and the redeem transactions associated to each onboard orders), it sends the pool transaction to the user(s).

Each user verify the transactions (pool and redeem). If it is ok, he signs its inputs and send the signed pset to ASP. 

## Sending 

### Spend the covenant leaf

Assuming Alice has virtual utxos locked on the covenant described above (and she didn't broadcast the redeem transaction), she can send the funds to Bob using the `covenant` leaf.

```ts
export type SendOrder = {
  address: string;
  amount: number;
  coin: UpdaterInput;
  signature: string;
  forfeitTx: string;
};
```
`signature` has the following message:
```
SHA256(txID | vout | witnessProgram | amount)
```

* `txID`: pool transaction id locking the virtual utxo.
* `vout`: pool transaction output index locking the virtual utxo.
* `witnessProgram`: witness program of the receiver address. Must be a segwit address.
* `amount`: satoshis to send to the receiver. encoded as 64 bits integer LE.

The user creates the message and signs it using the `redeemSecretKey` associated with `redeemPublicKey` used during onboarding.

The idea is to send this signature to the ASP, which will add it to the next pool transaction. The receiver won't receive the coin on-chain until the next pool transaction is broadcasted. 

But, from the ASP point of view, the coin is already spent because there is a now an incentive to broadcast it on-chain (get some fees).

Thus the receiver can check ASP to get its "virtual balance" before the next pool transaction.

### Forfeit the redeem transaction

The send message signature is not enough for the ASP to approve the order. The ASP must also ensures that the user will not broadcast the redeem transaction. 

To do so, user must create a *forfeit transaction* spending the redeem transaction output (which is not broadcasted) to the receiver script (+ get some fees for the ASP).

The forfeit transaction must be signed by user and ready to be broadcasted. Sending this transaction to the ASP is the proof that the user will lost its right to broadcast the redeem transaction.

> Until the send order is included in a pool transaction, the ASP has the job to scan the main chain. If the redeem tx has been broadcasted, it must broadcast the forfeit tx.

### Do not sign the pool transaction

The user don't have to sign the pool transaction where he didn't onboard coins. A send order is already "signed" thanks to the message. So the user has to send the message signature + forfeit transaction, wait for validation, and that's it: the coins are virtually sent.

