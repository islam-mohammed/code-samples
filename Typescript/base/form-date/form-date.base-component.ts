import { Directive, Input, OnInit } from '@angular/core';
import { select, Store } from '@ngrx/store';
import { UserRecipient } from '@pnp/api';
import { distinctUntilChanged, takeUntil } from 'rxjs/operators';
import { IValidateTargetUpdate } from '../../../services';
import { FormState } from '../../../state';
import { FormElementBaseComponent } from '../form-element/form-element.base-component';

/**
 * Form date abstraction.
 * This should be extended in web and mobile with platform specific templates
 */
@Directive()
export abstract class FormDateBaseComponent extends FormElementBaseComponent implements OnInit {
  @Input()
  ignoreDisplayingDefaultValue: boolean;
  protected doNotKnowBirthdayField = 'doNotKnowBirthday';

  protected constructor(public store: Store<FormState.IFeatureState>) {
    super(store);
  }

  ngOnInit() {
    if (this.formService.validateTargetUpdate$) {
      this.formService.validateTargetUpdate$
        .pipe(takeUntil(this.destroy$))
        .subscribe((update: IValidateTargetUpdate) => {
          if (update.name !== this.config.name) {
            return;
          }
          const updateChecked = !!parseInt(update.checked as any);
          switch (update.type) {
            case 'requiredIfEmpty':
              const control = this.group.get(update.target);
              if (!control.value) {
                this.config.validationMessages.push({
                  type: 'required',
                  message: update.errorMessage
                });
                this.setRequired();
              } else {
                this.config.validationMessages = this.config.validationMessages.filter((t: any) => !t.required);
                this.clearValidators();
              }
              this.config.disabled = updateChecked;
              break;
            case 'requiredIfNotEmpty':
              if (update.target) {
                if (updateChecked) {
                  this.config.validationMessages.push({
                    type: 'required',
                    message: update.errorMessage
                  });
                  this.setRequired();
                } else {
                  this.config.validationMessages = this.config.validationMessages.filter((t: any) => !t.required);
                  this.clearValidators();
                }
              }
              break;
          }
        });
    }
    if (this.config) {
      if (this.config.name === 'birthday') {
        this.store
          .pipe(select(FormState.selectCurrentRecipient), distinctUntilChanged(), takeUntil(this.destroy$))
          .subscribe((selectedRecipient: UserRecipient) => {
            if (selectedRecipient) {
              this.updateValue(selectedRecipient.birthday);
            }
          });
      }
    }
  }

  getDateValue(
    year: any,
    month: any, // 1-indexed
    day: any
  ): string {
    month = month < 10 ? `0${month}` : month;
    day = day < 10 ? `0${day}` : day;
    return `${year}-${month}-${day}`;
  }
}
