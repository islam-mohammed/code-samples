import { Directive, EventEmitter, Input, Output } from '@angular/core';
import { Store } from '@ngrx/store';
import { UserRecipient } from '@pnp/api';
import { FormState } from '../../../state';
import { FormElementBaseComponent } from '../form-element/form-element.base-component';
import { AppRecipient } from '../../../../shared/services/recipients.service';

/**
 * Form userRecipient abstraction.
 * This should be extended in web and mobile with platform specific templates
 */
@Directive()
export abstract class FormUserRecipientBaseComponent extends FormElementBaseComponent {
  @Input()
  recipient: AppRecipient;
  @Output()
  selected: EventEmitter<UserRecipient> = new EventEmitter();

  protected constructor(public store: Store<FormState.IFeatureState>) {
    super(store);
  }
}
