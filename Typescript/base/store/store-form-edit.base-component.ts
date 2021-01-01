import { OnInit, Directive } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Store } from '@ngrx/store';
import { FileService, UserRecipientsService, UserService, WindowService } from '@pnp/features/shared/services';
import { PersoItemActions } from '@pnp/features/user';
import { isPersoCalls } from '@pnp/utils';
import { combineLatest, Subject } from 'rxjs';
import { take, takeUntil, throttleTime } from 'rxjs/operators';
import { FormService } from '../../../services';
import { StoreFormBaseComponent } from './store-form.base-component';
import { AppPersoItem, AppPersoItemData, PersoItemService } from '../../../../shared/services/perso-item.service';
import { SocialLoginService } from '@pnp/features/shared/services/social-login.service';

@Directive()
export abstract class StoreFormEditBaseComponent extends StoreFormBaseComponent implements OnInit {
  nextButtonText: string;
  formUpdated$: Subject<boolean> = new Subject();
  private _initialized = false;
  private _initValueChanges = false;
  private _updating = false;
  private _persoItemDataMap = null;
  private _initForPageIndex: {
    [key: number]: boolean;
  } = {};

  protected constructor(
    store: Store<any>,
    win: WindowService,
    route: ActivatedRoute,
    formService: FormService,
    userService: UserService,
    recipientService: UserRecipientsService,
    fileService: FileService,
    protected persoItemService: PersoItemService,
    socialService: SocialLoginService
  ) {
    super(store, win, route, formService, userService, recipientService, fileService, socialService);

    // NOTE: This must be in constructor - since readyToEdit$ fires in super class ngOnInit - this must be setup before ngOnInit fires in parent
    this.readyToEdit$.pipe(takeUntil(this.destroy$)).subscribe(_ => {
      if (this._initialized) {
        // if it had already been initialized and is not currently updating, the user likely returned to recipient list while editing so just allow
        // adjusting of data to occur again
        this._adjustData();
      } else {
        if (this.editItemId) {
          combineLatest([
            this.persoItemService.getPersoById(this.editItemId),
            this.persoItemService.getPersoDataById(this.editItemId)
          ])
            .pipe(take(1))
            .subscribe(([persoItem, persoItemData]: [AppPersoItem, AppPersoItemData]) => {
              if (!this._initialized) {
                this._initialized = true;
                this.title = isPersoCalls(persoItem)
                  ? $localize`:@@call-info.edit-lbl:Edit call`
                  : $localize`:@@video.edit-lbl:Edit video`;

                let recipientId = null;
                this._persoItemDataMap = [];
                persoItemData.dataMap.forEach(prop => {
                  this._persoItemDataMap[prop[0]] = prop[1];
                  if (prop[0] === 'userRecipient') {
                    recipientId = prop[1];
                  }
                });

                this.selectRecipient({
                  id: recipientId
                });

                this._adjustData();
              } else if (this._updating) {
                // successfully updated if a change was triggered here on the state and it was in process of updating
                this.formUpdated$.next(true);
              }
            });
        }
      }
    });
  }

  prevPage() {
    const promise = super.prevPage();
    this._adjustData();
    return promise;
  }

  nextPage() {
    super.nextPage(this.acceptTerms);
    this._adjustData();
    return false;
  }

  submitAction(item: AppPersoItem) {
    item.id = this.editItemId;
    this._updating = true;
    // this.newsletterChange();
    this.store.dispatch(new PersoItemActions.UpdateAction(item));
  }

  private _adjustData() {
    this.win.setTimeout(() => {
      this._adjustButtons();
      const form = this.getRawFormGroup();
      if (form) {
        if (!this._initForPageIndex[this.currentPage]) {
          this._initForPageIndex[this.currentPage] = true;

          for (const key in form.controls) {
            if (form.controls.hasOwnProperty(key)) {
              form.controls[key].setValue(this._persoItemDataMap[key]);
            }
          }
        }
        if (!this._initValueChanges) {
          // ensure all form value changes update the editedItem
          // only wire this up once when form is ready
          this._initValueChanges = true;
          form.valueChanges.pipe(throttleTime(300), takeUntil(this.destroy$)).subscribe((value: any) => {
            if (value) {
              // update edited item with form value changes
              for (const key in value) {
                if (value[key] != null) {
                  this._persoItemDataMap[key] = value[key];
                }
              }
            }
          });
        }
      }
    }, 200);
  }

  private _adjustButtons() {
    // adjust form button to reflect editing vs. creation
    if (this.formSection?.page && this.formSection.page.nextButton) {
      // use update text and final button
      this.nextButtonText = this.formSection.page.nextButton.replace('Create', 'Update');
    }
  }
}
