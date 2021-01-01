import { Directive, EventEmitter, Input, OnInit, Output } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { select, Store } from "@ngrx/store";
import { QuestionChoice, UserRecipient } from "@pnp/api";
import {
  AppRecipient,
  FileService,
  UserDetailService,
  UserRecipientsService,
  UserService,
  WindowService,
} from "@pnp/features/shared/services";
import { RecipientActions } from "@pnp/features/user";
import { Subject } from "rxjs";
import {
  debounceTime,
  distinctUntilChanged,
  filter,
  takeUntil,
  throttleTime,
} from "rxjs/operators";
import { FormService } from "../../../services";
import { FormState } from "../../../state";
import { StoreFormBaseComponent } from "./store-form.base-component";
import { TokenString } from "src/app/xplat/core/services/token-string";
import { SocialLoginService } from "@pnp/features/shared/services/social-login.service";
import { CatalogState } from "../../../../catalog";

@Directive()
export abstract class RecipientFormEditBaseComponent
  extends StoreFormBaseComponent
  implements OnInit {
  @Input()
  activeConfig: FormState.IFormConfig;
  @Input()
  recipient: AppRecipient;
  @Output()
  submitForm: EventEmitter<any> = new EventEmitter();

  @Output()
  backToRecipient: EventEmitter<any> = new EventEmitter();
  editedItem: any;
  nextButtonText: string;
  formUpdated$: Subject<boolean> = new Subject();
  private _initialized = false;
  private _initValueChanges = false;
  private _updating = false;
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
    private _userDetailService: UserDetailService,
    fileService: FileService,
    socialService: SocialLoginService
  ) {
    super(
      store,
      win,
      route,
      formService,
      userService,
      recipientService,
      fileService,
      socialService
    );
    // NOTE: This must be in constructor - since readyToEdit$ fires in super class ngOnInit - this must be setup before ngOnInit fires in parent
    this.readyToEdit$.pipe(takeUntil(this.destroy$)).subscribe((_) => {
      if (this._initialized) {
        // if it had already been initialized and is not currently updating, the user likely returned to recipient list while editing so just allow
        // adjusting of data to occur again
        this._adjustData();
      } else {
        if (!this._initialized) {
          this._initialized = true;
          const selected = this.recipients.filter(
            (rec) => rec.id === this.recipient.id
          );
          this.win.setTimeout(() => {
            // initiate auto selection on next jvm tick
            this._adjustData();
          });
        } else if (this._updating) {
          // successfully updated if a change was triggered here on the state and it was in process of updating
          this.formUpdated$.next(true);
        }
      }
    });
  }

  get isConverted() {
    return this._userDetailService.isConverted;
  }

  ngOnInit() {
    this.store
      .select(CatalogState.selectUserUpsell)
      .pipe(takeUntil(this.destroy$))
      .subscribe((upsell) => {
        this._userDetailService.isConverted = !upsell;
      });
    super.ngOnInit();
    if (this.recipient) {
      this.editedItem = Object.assign({}, this.recipient);
      this.selectRecipient(this.recipient);
      this.readyToEdit$.next(true);
    }
    this.store
      .pipe(
        select(FormState.selectCurrentRecipient),
        filter((x) => !x),
        distinctUntilChanged(),
        debounceTime(500),
        takeUntil(this.destroy$)
      )
      .subscribe(() => {
        this._trackFormControls();
      });
  }

  submit(value?: { [name: string]: any }): void {
    if (!this.recipient) {
      this._trackFormControls();
    }

    const data: any = {};
    for (const pageIndex in this.formControlSets) {
      const controlSet = this.formControlSets[pageIndex];
      for (const key in controlSet) {
        data[key] = controlSet[key].value;
      }
    }

    const recipient: UserRecipient = {
      ...this.selectedRecipient,
    };
    recipient.data = this.formatData(data);

    // TODO: this is a hack, but its safe and simple enough for now - Dick 2019-12-10
    let groupName;
    const toFirstNamePlural = recipient.data.toFirstNamePlural;
    // If we have toFirstNamePlural, we have a group form
    if (toFirstNamePlural) {
      // We assume page 0, block 1, question 0, section 0
      try {
        const options = (<QuestionChoice>(
          this.activeConfig.pages[0].fieldBlocks[1].questions[0]
        )).sections[0].options;
        const match = options.find((o) => +o.value === +toFirstNamePlural);
        groupName = match.message;
      } catch (_) {
        //
      }
    }

    // Fallback, just display the old name
    recipient.name = recipient.data.toFirstName || groupName || recipient.name;
    if (recipient.name) {
      recipient.birthday = recipient.data.birthday;
      this.formService.isDirty = false;

      this.uploadRecipientImages(recipient).then((updatedRecipient) => {
        if (this.selectedRecipient?.id) {
          this.submitUpdateAction(updatedRecipient);
        } else {
          this.submitCreateAction(updatedRecipient);
        }
      });
    } else {
      this.win.alert(TokenString.Error.BLANK_NAME_LBL);
    }
  }

  submitCreateAction(item) {
    this._updating = true;
    // this.newsletterChange();
    this.store.dispatch(new RecipientActions.CreateAction(item));
    this.submitForm.next();
    this.resetRecipient(false);
  }

  submitUpdateAction(item) {
    this._updating = true;
    // this.newsletterChange();
    this.store.dispatch(new RecipientActions.UpdateAction(item));
    // Wait for update before fetching all other recipients
    this.win.setTimeout((_) => {
      this.store.dispatch(
        new RecipientActions.FetchAllAction({
          forceRefresh: true,
        })
      );
    }, 1000);
    this.submitForm.next();
    this.resetRecipient(false);
  }

  private _adjustData() {
    this.win.setTimeout(() => {
      this._adjustButtons();
      const form = this.getRawFormGroup();
      if (form) {
        // only set with edited data once
        // when navigating through an edited form back/forth after the initial set, we want it to retain the new values the user is editing
        if (!this._initForPageIndex[this.currentPage]) {
          this._initForPageIndex[this.currentPage] = true;
          for (const key in form.controls) {
            if (form.controls.hasOwnProperty(key)) {
              form.controls[key].setValue(this.editedItem.dataMap[key]);
            }
          }
        }
        if (!this._initValueChanges) {
          // ensure all form value changes update the editedItem
          // only wire this up once when form is ready
          this._initValueChanges = true;
          form.valueChanges
            .pipe(throttleTime(300), takeUntil(this.destroy$))
            .subscribe((value: any) => {
              if (value) {
                // update edited item with form value changes
                for (const key in value) {
                  this.editedItem.dataMap[key] = value[key];
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
      this.nextButtonText = this.formSection.page.nextButton.replace(
        "Create",
        "Update"
      );
    }
  }
}
