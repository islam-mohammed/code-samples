/* 
 A retry mechanism to apply on any gRPC call function that returns observables
 It will try a number of times with an accending waiting period in between
 The error will be thrown to the error handler in effect class after retry failure
*/

import { of, throwError, timer } from "rxjs";
import {
  catchError,
  delayWhen,
  exhaustMap,
  mergeMap,
  retryWhen,
} from "rxjs/operators";

export function retry(retryAttempts = 3) {
  const intervals = [1, 4, 8];
  const includeStatusCodes = [14];
  return (target, key, descriptor) => {
    const originalMethod = descriptor.value;
    descriptor.value = function (...args: any[]) {
      return originalMethod.apply(this, args).pipe(
        exhaustMap((d) => of(d)),
        retryWhen((errors) => {
          return errors.pipe(
            mergeMap((error, i) => {
              const attempt = i + 1;
              console.log(
                "Attempt No:",
                attempt,
                "For Function:",
                originalMethod
              );
              if (
                attempt === retryAttempts ||
                !includeStatusCodes.includes(error.code)
              ) {
                return throwError(error);
              } else {
                return of(i);
              }
            }),
            delayWhen((errorCount) => timer(1000 * intervals[errorCount + 1]))
          );
        }),
        catchError((err) => {
          throw err;
        })
      );
    };

    return descriptor;
  };
}

// Implmentation example ////////

/*
@retry(3)
createTokens(email: string, password: string): Observable<IUser> {
  this.authRequest.setType(AuthRequest.Type.EMAIL);
  const emailAuth = new AuthRequest.EmailAuth();
  emailAuth.setEmail(email);
  emailAuth.setPassword(password);
  this.authRequest.setEmailAuth(emailAuth);
  const metaData = this.grpcService.getMetadata();
  return new Observable<IUser>(observer => {
    const req = this.authServiceClient.authenticate(
      this.authRequest,
      metaData,
      (err: grpcWeb.Error, authResponse: AuthResponse) => {
        if (err) {
          localStorage.removeItem(StorageKeys.TOKEN);
          observer.error(new Error(TokenString.Auth.INVALID_PASSWORD));
        } else {
          localStorage.setItem(StorageKeys.TOKEN, authResponse.toObject().bearerToken);
          const metadata = this.grpcService.getMetadata();
          const request = new google_protobuf_empty_pb.Empty();
          this.userServiceClient.getUser(request, metadata, (err: grpcWeb.Error, user: User) => {
            if (err) {
              observer.error(new Error(err.message));
            } else {
              observer.next({
                ...user.toObject(),
                tokens: authResponse.toObject()
              });
              observer.complete();
            }
          });
        }
      }
    );
    return () => req.cancel();
  });
}
*/
